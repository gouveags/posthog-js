import { CoreExtension as CoreExtensionToken } from '@posthog/browser-common'
import type {
    ApiRequestInit,
    ApiResponse,
    CaptureOptions as BrowserCommonCaptureOptions,
    Client,
    CoreExtension,
    Disposable,
    Extension,
    ExtensionToken,
    KeyValueStore,
    Listener,
    NewSessionInfo,
    NewSessionReason,
    RemoteConfig as BrowserCommonRemoteConfig,
    SessionContext,
} from '@posthog/browser-common'
import { isArray, isFunction, isUndefined, type Logger } from '@posthog/core'
import { logger } from '@posthog/browser-common/utils/logger'

import { DEVICE_ID } from '../constants'
import { extendURLParams } from '../request'
import type { PostHog } from '../posthog-core'
import type {
    CaptureOptions,
    EventName,
    Properties,
    Property,
    QueuedRequestWithOptions,
    RemoteConfigResult,
} from '../types'

interface RegisteredExtension {
    extension: Extension
    setupPromise: Promise<void>
    disposalPromise?: Promise<void>
}

function detachedSnapshot<T>(value: T, seen = new Map<object, unknown>()): T {
    if (!value || typeof value !== 'object') {
        return value
    }
    if (Object.prototype.toString.call(value) === '[object Date]') {
        return new Date((value as unknown as Date).getTime()) as T
    }

    const existing = seen.get(value)
    if (existing) {
        return existing as T
    }

    const snapshot: unknown = isArray(value) ? [] : {}
    seen.set(value, snapshot)
    Object.keys(value).forEach((key) => {
        ;(snapshot as Record<string, unknown>)[key] = detachedSnapshot((value as Record<string, unknown>)[key], seen)
    })
    return snapshot as T
}

function stripQueryParameter(url: string, parameter: string): string {
    const hashIndex = url.indexOf('#')
    const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex)
    const queryIndex = withoutHash.indexOf('?')
    if (queryIndex === -1) {
        return withoutHash
    }

    const base = withoutHash.slice(0, queryIndex)
    const query = withoutHash
        .slice(queryIndex + 1)
        .split('&')
        .filter((pair) => {
            const encodedKey = pair.split('=')[0].replace(/\+/g, ' ')
            try {
                return decodeURIComponent(encodedKey) !== parameter
            } catch {
                return encodedKey !== parameter
            }
        })
        .join('&')
    return `${base}${query ? `?${query}` : ''}`
}

function withoutQueryParameter(query: Record<string, string> | undefined, parameter: string): Record<string, string> {
    const filtered: Record<string, string> = {}
    Object.keys(query ?? {}).forEach((key) => {
        let decodedKey = key
        try {
            decodedKey = decodeURIComponent(key.replace(/\+/g, ' '))
        } catch {
            // Preserve malformed, unrelated keys verbatim.
        }
        if (decodedKey !== parameter) {
            filtered[key] = query![key]
        }
    })
    return filtered
}

class BrowserExtensionKeyValueStore implements KeyValueStore {
    constructor(private readonly _instance: PostHog) {}

    get<T = unknown>(key: string): T | undefined {
        return this._instance.persistence?.props[key] as T | undefined
    }

    set(key: string, value: unknown): void {
        this._instance.persistence?.register({ [key]: value as Property })
    }

    remove(key: string): void {
        this._instance.persistence?.unregister(key)
    }
}

function disposable(dispose: () => void): Disposable {
    let active = true
    return {
        dispose: () => {
            if (!active) {
                return
            }
            active = false
            dispose()
        },
    }
}

const REMOTE_CONFIG_EVENT = 'extensionsRemoteConfig'
const NEW_SESSION_EVENT = 'extensionsNewSession'

/**
 * One browser-v1 host per PostHog instance. It owns shared extension lifecycle,
 * capability registration, and event streams while each extension receives a
 * Client adapter.
 */
export class BrowserExtensionHost implements Disposable {
    private readonly _extensions = new Map<string, RegisteredExtension>()
    private readonly _registrationOrder: RegisteredExtension[] = []
    private readonly _providerReservations = new Map<string, RegisteredExtension>()
    private readonly _providers = new Map<string, unknown>()
    private readonly _remoteConfigWaiters: Array<(config: BrowserCommonRemoteConfig | undefined) => void> = []
    private readonly _logger: Logger
    private _latestRemoteConfigResult: RemoteConfigResult | undefined
    private _sessionSource: PostHog['sessionManager']
    private _removeSessionListener: (() => void) | undefined
    private _removeForcedIdleResetListener: (() => void) | undefined
    private _pendingSessionReason: NewSessionReason | undefined
    private _pendingForcedIdleReset = false
    private _disposePromise: Promise<void> | undefined
    private _disposed = false

    constructor(readonly instance: PostHog) {
        this._logger = logger.createLogger('[BrowserExtensions]')
        this._latestRemoteConfigResult = instance._lastRemoteConfig
        this.rebindSessionSource()
        void this.add(new BrowserCoreExtension(this))
    }

    get logger(): Logger {
        return this._logger
    }

    get onRemoteConfig(): Listener<BrowserCommonRemoteConfig> {
        return (handler) =>
            disposable(
                this.instance._internalEventEmitter.on(REMOTE_CONFIG_EVENT, (config) => {
                    this._invokeListener('remote config', handler, detachedSnapshot(config))
                })
            )
    }

    get onNewSession(): Listener<NewSessionInfo> {
        return (handler) =>
            disposable(
                this.instance._internalEventEmitter.on(NEW_SESSION_EVENT, (session) => {
                    this._invokeListener('new session', handler, detachedSnapshot(session))
                })
            )
    }

    add(extension: Extension): Promise<void> {
        if (this._disposed) {
            throw new Error('Cannot add an extension to a disposed BrowserExtensionHost')
        }
        if (this._extensions.has(extension.name)) {
            throw new Error(`Browser extension "${extension.name}" is already registered`)
        }

        for (const token of extension.provides ?? []) {
            if (this._providerReservations.has(token)) {
                throw new Error(`Browser extension token "${token}" is already registered`)
            }
        }

        const adapter = new BrowserClientAdapter(this, extension.name)
        // eslint-disable-next-line compat/compat -- Extension setup is intentionally awaitable.
        const registered = { extension, setupPromise: Promise.resolve() } satisfies RegisteredExtension
        this._extensions.set(extension.name, registered)
        this._registrationOrder.push(registered)
        for (const token of extension.provides ?? []) {
            this._providerReservations.set(token, registered)
        }

        let setupResult: void | Promise<void>
        try {
            setupResult = extension.setup(adapter)
        } catch (error) {
            registered.setupPromise = this._handleSetupFailure(registered, error)
            return registered.setupPromise
        }

        if (setupResult && isFunction(setupResult.then)) {
            registered.setupPromise = setupResult
                .then(() => this._publishRegistration(registered))
                .catch((error) => this._handleSetupFailure(registered, error))
        } else {
            this._publishRegistration(registered)
        }
        return registered.setupPromise
    }

    getExtension<T>(token: ExtensionToken<T>): T | undefined {
        return this._providers.get(token) as T | undefined
    }

    handleRemoteConfig(result: RemoteConfigResult): void {
        if (this._disposed) {
            return
        }

        this._latestRemoteConfigResult = result
        const config = result.ok ? (result.config as unknown as BrowserCommonRemoteConfig) : undefined
        this._remoteConfigWaiters.splice(0).forEach((resolve) => resolve(detachedSnapshot(config)))
        if (config) {
            this.instance._internalEventEmitter.emit(REMOTE_CONFIG_EVENT, config)
        }
    }

    async getRemoteConfig(): Promise<BrowserCommonRemoteConfig | undefined> {
        if (this._latestRemoteConfigResult) {
            return this._latestRemoteConfigResult.ok
                ? detachedSnapshot(this._latestRemoteConfigResult.config as unknown as BrowserCommonRemoteConfig)
                : undefined
        }
        if (this.instance._shouldDisableFlags()) {
            return undefined
        }
        // eslint-disable-next-line compat/compat -- The shared Client contract requires an awaitable first result.
        return new Promise((resolve) => this._remoteConfigWaiters.push(resolve))
    }

    dispose(): Promise<void> {
        if (!this._disposePromise) {
            this._disposed = true
            this._disposePromise = this._disposeAll()
        }
        return this._disposePromise
    }

    markReset(): void {
        this._pendingSessionReason = 'reset'
    }

    rebindSessionSource(): void {
        if (this._disposed || this._sessionSource === this.instance.sessionManager) {
            return
        }
        this._removeSessionListener?.()
        this._removeForcedIdleResetListener?.()
        this._removeSessionListener = undefined
        this._removeForcedIdleResetListener = undefined
        this._pendingForcedIdleReset = false

        const sessionSource = this.instance.sessionManager
        this._sessionSource = sessionSource
        this._removeForcedIdleResetListener = sessionSource?.on?.('forcedIdleReset', () => {
            if (!this._disposed && this._sessionSource === sessionSource) {
                this._pendingForcedIdleReset = true
            }
        })
        this._removeSessionListener = this.instance.onSessionId((sessionId, windowId, changeReason) => {
            const isSessionRotation =
                !!changeReason?.noSessionId ||
                !!changeReason?.activityTimeout ||
                !!changeReason?.sessionPastMaximumLength ||
                !!changeReason?.crossTabAdoption
            if (!isSessionRotation) {
                return
            }

            const pendingSessionReason = this._pendingSessionReason
            const pendingForcedIdleReset = this._pendingForcedIdleReset
            this._pendingSessionReason = undefined
            this._pendingForcedIdleReset = false

            let reason: NewSessionReason
            if (pendingSessionReason) {
                reason = pendingSessionReason
            } else if (pendingForcedIdleReset) {
                reason = 'idleTimeout'
            } else if (changeReason?.crossTabAdoption) {
                reason = 'crossTabAdoption'
            } else if (changeReason?.activityTimeout) {
                reason = 'idleTimeout'
            } else if (changeReason?.sessionPastMaximumLength) {
                reason = 'maxLength'
            } else {
                reason = 'initial'
            }

            const current = this._sessionContext(sessionId, windowId ?? '')
            this.instance._internalEventEmitter.emit(NEW_SESSION_EVENT, { ...current, reason })
        })
    }

    private async _disposeAll(): Promise<void> {
        this._remoteConfigWaiters.splice(0).forEach((resolve) => resolve(undefined))
        for (const registered of this._registrationOrder.slice().reverse()) {
            await registered.setupPromise
            await this._disposeRegistration(registered)
        }

        this._extensions.clear()
        this._registrationOrder.length = 0
        this._providerReservations.clear()
        this._providers.clear()
        this._removeSessionListener?.()
        this._removeForcedIdleResetListener?.()
        this._removeSessionListener = undefined
        this._removeForcedIdleResetListener = undefined
        this._sessionSource = undefined
        this._pendingSessionReason = undefined
        this._pendingForcedIdleReset = false
        this.instance._internalEventEmitter.clear(REMOTE_CONFIG_EVENT)
        this.instance._internalEventEmitter.clear(NEW_SESSION_EVENT)
    }

    private async _handleSetupFailure(registered: RegisteredExtension, error: unknown): Promise<void> {
        this._removeRegistration(registered)
        this._logger.error(`Failed to set up browser extension "${registered.extension.name}"`, error)
        await this._disposeRegistration(registered)
        const index = this._registrationOrder.indexOf(registered)
        if (index !== -1) {
            this._registrationOrder.splice(index, 1)
        }
    }

    private _disposeRegistration(registered: RegisteredExtension): Promise<void> {
        if (!registered.disposalPromise) {
            registered.disposalPromise = Promise.resolve()
                .then(() => registered.extension.dispose())
                .catch((error) => {
                    this._logger.error(`Failed to dispose browser extension "${registered.extension.name}"`, error)
                })
        }
        return registered.disposalPromise
    }

    private _removeRegistration(registered: RegisteredExtension): void {
        if (this._extensions.get(registered.extension.name) === registered) {
            this._extensions.delete(registered.extension.name)
        }
        for (const token of registered.extension.provides ?? []) {
            if (this._providerReservations.get(token) === registered) {
                this._providerReservations.delete(token)
            }
            if (this._providers.get(token) === registered.extension) {
                this._providers.delete(token)
            }
        }
    }

    private _publishRegistration(registered: RegisteredExtension): void {
        if (this._disposed || this._extensions.get(registered.extension.name) !== registered) {
            return
        }
        for (const token of registered.extension.provides ?? []) {
            this._providers.set(token, registered.extension)
        }
    }

    private _invokeListener<T>(stream: string, handler: (value: T) => void, value: T): void {
        try {
            handler(value)
        } catch (error) {
            this._logger.error(`Browser extension ${stream} listener failed`, error)
        }
    }

    sessionContext(): SessionContext {
        return this._sessionContext()
    }

    private _sessionContext(sessionId?: string, windowId?: string): SessionContext {
        try {
            const current = this.instance.sessionManager?.checkAndGetSessionAndWindowId(true)
            return {
                sessionId: sessionId ?? current?.sessionId ?? '',
                windowId: windowId ?? current?.windowId ?? '',
                sessionStartTimestamp: current?.sessionStartTimestamp ?? 0,
            }
        } catch {
            return {
                sessionId: sessionId ?? '',
                windowId: windowId ?? '',
                sessionStartTimestamp: 0,
            }
        }
    }
}

/** The browser-v1 implementation of the shared core analytics extension. */
class BrowserCoreExtension implements CoreExtension {
    readonly name = 'core'
    readonly provides = [CoreExtensionToken]
    readonly onEvent: Listener<{ event: string; properties: Record<string, unknown> }>
    readonly onNewSession: Listener<NewSessionInfo>
    readonly onRemoteConfig: Listener<BrowserCommonRemoteConfig>

    constructor(private readonly _host: BrowserExtensionHost) {
        this.onEvent = (handler) => {
            const unsubscribe = this._host.instance.on('eventCaptured', (event) => {
                try {
                    handler({
                        event: event.event,
                        properties: detachedSnapshot(event.properties as Record<string, unknown>),
                    })
                } catch (error) {
                    this._host.logger.error('Browser extension event listener failed', error)
                }
            })
            return disposable(unsubscribe)
        }
        this.onNewSession = _host.onNewSession
        this.onRemoteConfig = _host.onRemoteConfig
    }

    get distinctId(): string {
        return this._host.instance.get_distinct_id()
    }

    get anonymousId(): string {
        return (this._host.instance.get_property(DEVICE_ID) as string | undefined) ?? this.distinctId
    }

    get groups(): Record<string, string> {
        return this._host.instance.getGroups() as Record<string, string>
    }

    get session(): SessionContext {
        return this._host.sessionContext()
    }

    setup(): void {}

    async capture(event: string, properties?: Properties | null, options?: BrowserCommonCaptureOptions): Promise<void> {
        if (!options) {
            this._host.instance.capture(event as EventName, properties)
            return
        }

        const captureOptions: CaptureOptions = {
            timestamp: options.timestamp,
            uuid: options.uuid,
            $set: options.set as Properties | undefined,
            $set_once: options.setOnce as Properties | undefined,
        }
        this._host.instance.capture(event as EventName, properties, captureOptions)
    }

    registerDynamicEventProperties(producer: () => Record<string, unknown>): Disposable {
        return disposable(this._host.instance._registerExtensionEventProperties(producer))
    }

    getRemoteConfig(): Promise<BrowserCommonRemoteConfig | undefined> {
        return this._host.getRemoteConfig()
    }

    dispose(): void {}
}

/** A host-services facade scoped to one shared extension. */
export class BrowserClientAdapter implements Client {
    readonly kv: KeyValueStore
    readonly logger: Logger

    constructor(
        private readonly _host: BrowserExtensionHost,
        extensionName: string
    ) {
        this.kv = new BrowserExtensionKeyValueStore(_host.instance)
        this.logger = _host.logger.createLogger(`[${extensionName}]`)
    }

    async apiRequest(path: string, init: ApiRequestInit = {}): Promise<ApiResponse> {
        const instance = this._host.instance
        const target = /^\/?flags(?:\/|\?|$)/.test(path) ? 'flags' : 'api'
        let body = init.body as Record<string, unknown> | undefined
        if (target === 'flags') {
            if (isUndefined(body)) {
                body = { token: instance.config.token }
            } else if (!body || typeof body !== 'object' || isArray(body)) {
                return {
                    statusCode: 0,
                    error: new TypeError('Browser extension flags requests require an object body'),
                }
            } else {
                body = { ...body }
                delete body.token
                delete body.$token
                delete body.api_key
                body.token = instance.config.token
            }
        }

        const endpoint = stripQueryParameter(instance.requestRouter.endpointFor(target, path), 'token')
        const query = {
            ...withoutQueryParameter(init.query, 'token'),
            token: instance.config.token,
        }
        const requestOptions: QueuedRequestWithOptions = {
            method: init.method ?? 'POST',
            url: extendURLParams(endpoint, query, false),
            data: body,
            timeout: init.timeoutMs,
            noRetries: true,
            fireCallbackOnDrop: true,
            transport: init.unload ? 'sendBeacon' : undefined,
        }

        if (init.unload) {
            this._host.instance._send_request(requestOptions)
            return { statusCode: 202 }
        }

        // eslint-disable-next-line compat/compat -- The shared Client transport is intentionally awaitable.
        return new Promise((resolve) => {
            requestOptions.callback = resolve
            this._host.instance._send_request(requestOptions)
        })
    }

    getExtension<T>(token: ExtensionToken<T>): T | undefined {
        return this._host.getExtension(token)
    }
}
