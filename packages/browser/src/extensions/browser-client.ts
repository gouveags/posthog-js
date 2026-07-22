/* eslint-disable compat/compat -- the shared Client contract is async and Promise-based */

import type {
    ApiRequestInit,
    ApiResponse,
    CaptureOptions as BrowserCommonCaptureOptions,
    Client,
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
import type { Logger } from '@posthog/core'
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
    private readonly _providers = new Map<ExtensionToken<unknown>, unknown>()
    private readonly _remoteConfigWaiters: Array<(config: BrowserCommonRemoteConfig | undefined) => void> = []
    private readonly _logger: Logger
    private _latestRemoteConfigResult: RemoteConfigResult | undefined
    private _removeSessionListener: (() => void) | undefined
    private _pendingSessionReason: NewSessionReason | undefined
    private _disposePromise: Promise<void> | undefined
    private _disposed = false

    constructor(readonly instance: PostHog) {
        this._logger = logger.createLogger('[BrowserExtensions]')
        this._latestRemoteConfigResult = instance._lastRemoteConfig
        this._subscribeToSessions()
    }

    get logger(): Logger {
        return this._logger
    }

    get onRemoteConfig(): Listener<BrowserCommonRemoteConfig> {
        return (handler) => disposable(this.instance._internalEventEmitter.on(REMOTE_CONFIG_EVENT, handler))
    }

    get onNewSession(): Listener<NewSessionInfo> {
        return (handler) => disposable(this.instance._internalEventEmitter.on(NEW_SESSION_EVENT, handler))
    }

    add(extension: Extension): void {
        if (this._disposed) {
            throw new Error('Cannot add an extension to a disposed BrowserExtensionHost')
        }
        if (this._extensions.has(extension.name)) {
            throw new Error(`Browser extension "${extension.name}" is already registered`)
        }

        for (const token of extension.provides ?? []) {
            if (this._providers.has(token)) {
                throw new Error(`Browser extension token "${token.name}" is already registered`)
            }
        }

        const adapter = new BrowserClientAdapter(this, extension.name)
        const registered = { extension, setupPromise: Promise.resolve() } satisfies RegisteredExtension
        this._extensions.set(extension.name, registered)
        this._registrationOrder.push(registered)
        for (const token of extension.provides ?? []) {
            this._providers.set(token, extension)
        }

        let setupResult: void | Promise<void>
        try {
            setupResult = extension.setup(adapter)
        } catch (error) {
            registered.setupPromise = this._handleSetupFailure(registered, error)
            return
        }

        registered.setupPromise = Promise.resolve(setupResult).catch((error) =>
            this._handleSetupFailure(registered, error)
        )
    }

    getExtension<T>(token: ExtensionToken<T>): T | undefined {
        return this._providers.get(token as ExtensionToken<unknown>) as T | undefined
    }

    handleRemoteConfig(result: RemoteConfigResult): void {
        if (this._disposed) {
            return
        }

        this._latestRemoteConfigResult = result
        const config = result.ok ? (result.config as unknown as BrowserCommonRemoteConfig) : undefined
        this._remoteConfigWaiters.splice(0).forEach((resolve) => resolve(config))
        if (config) {
            this.instance._internalEventEmitter.emit(REMOTE_CONFIG_EVENT, config)
        }
    }

    async getRemoteConfig(): Promise<BrowserCommonRemoteConfig | undefined> {
        if (this._latestRemoteConfigResult) {
            return this._latestRemoteConfigResult.ok
                ? (this._latestRemoteConfigResult.config as unknown as BrowserCommonRemoteConfig)
                : undefined
        }
        if (this.instance._shouldDisableFlags()) {
            return undefined
        }
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

    private async _disposeAll(): Promise<void> {
        this._remoteConfigWaiters.splice(0).forEach((resolve) => resolve(undefined))
        for (const registered of this._registrationOrder.slice().reverse()) {
            await registered.setupPromise
            await this._disposeRegistration(registered)
        }

        this._extensions.clear()
        this._registrationOrder.length = 0
        this._providers.clear()
        this._removeSessionListener?.()
        this._removeSessionListener = undefined
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
            if (this._providers.get(token) === registered.extension) {
                this._providers.delete(token)
            }
        }
    }

    private _subscribeToSessions(): void {
        this._removeSessionListener = this.instance.onSessionId((sessionId, windowId, changeReason) => {
            const isSessionRotation =
                !!changeReason?.noSessionId ||
                !!changeReason?.activityTimeout ||
                !!changeReason?.sessionPastMaximumLength ||
                !!changeReason?.crossTabAdoption
            if (!isSessionRotation) {
                return
            }

            let reason: NewSessionReason
            if (this._pendingSessionReason) {
                reason = this._pendingSessionReason
                this._pendingSessionReason = undefined
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

/** A Client facade scoped to one shared extension. */
export class BrowserClientAdapter implements Client {
    readonly kv: KeyValueStore
    readonly logger: Logger
    readonly onRemoteConfig: Listener<BrowserCommonRemoteConfig>
    readonly onNewSession: Listener<NewSessionInfo>

    constructor(
        private readonly _host: BrowserExtensionHost,
        extensionName: string
    ) {
        this.kv = new BrowserExtensionKeyValueStore(_host.instance)
        this.logger = _host.logger.createLogger(`[${extensionName}]`)
        this.onRemoteConfig = _host.onRemoteConfig
        this.onNewSession = _host.onNewSession
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

    async capture(event: string, properties?: Properties | null, options?: BrowserCommonCaptureOptions): Promise<void> {
        const captureOptions: CaptureOptions = {
            timestamp: options?.timestamp,
            uuid: options?.uuid,
            $set: options?.set as Properties | undefined,
            $set_once: options?.setOnce as Properties | undefined,
        }
        this._host.instance.capture(event as EventName, properties, captureOptions)
    }

    registerDynamicEventProperties(producer: () => Record<string, unknown>): Disposable {
        return disposable(this._host.instance._registerExtensionEventProperties(producer))
    }

    async apiRequest(path: string, init: ApiRequestInit = {}): Promise<ApiResponse> {
        const instance = this._host.instance
        const target = /^\/?flags(?:\/|\?|$)/.test(path) ? 'flags' : 'api'
        const endpoint = instance.requestRouter.endpointFor(target, path)
        const query = { ...init.query, token: init.query?.token || instance.config.token }
        const requestOptions: QueuedRequestWithOptions = {
            method: init.method ?? 'POST',
            url: extendURLParams(endpoint, query, false),
            data: init.body as Record<string, unknown> | undefined,
            timeout: init.timeoutMs,
            noRetries: true,
            fireCallbackOnDrop: true,
            transport: init.unload ? 'sendBeacon' : undefined,
        }

        if (init.unload) {
            this._host.instance._send_request(requestOptions)
            return { statusCode: 202 }
        }

        return new Promise((resolve) => {
            requestOptions.callback = resolve
            this._host.instance._send_request(requestOptions)
        })
    }

    getRemoteConfig(): Promise<BrowserCommonRemoteConfig | undefined> {
        return this._host.getRemoteConfig()
    }

    readonly onEvent: Listener<{ event: string; properties: Record<string, unknown> }> = (handler) => {
        const unsubscribe = this._host.instance.on('eventCaptured', (event) => {
            handler({ event: event.event, properties: event.properties as Record<string, unknown> })
        })
        return disposable(unsubscribe)
    }

    getExtension<T>(token: ExtensionToken<T>): T | undefined {
        return this._host.getExtension(token)
    }
}
