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
import { Publisher } from '@posthog/browser-common'
import { isNullish, isUndefined } from '@posthog/core'
import type { Logger } from '@posthog/core'
import { logger } from '@posthog/browser-common/utils/logger'
import { formDataToQuery, getQueryParam } from '@posthog/browser-common/utils/request-utils'

import { BROWSER_EXTENSION_KV_PREFIX, DEVICE_ID } from '../constants'
import type { PostHog } from '../posthog-core'
import type {
    CaptureOptions,
    EventName,
    Properties,
    Property,
    QueuedRequestWithOptions,
    RemoteConfigResult,
} from '../types'

export interface BrowserExtensionRegistrationOptions {
    /** Map an extension-local key to an existing v1 persistence key. */
    kvAliases?: Record<string, string>
}

interface RegisteredExtension {
    extension: Extension
    adapter: BrowserClientAdapter
    setupPromise: Promise<void>
    disposalPromise?: Promise<void>
}

class BrowserExtensionKeyValueStore implements KeyValueStore {
    private readonly _memory = new Map<string, unknown>()

    constructor(
        private readonly _instance: PostHog,
        private readonly _extensionName: string,
        private readonly _aliases: Record<string, string>
    ) {}

    private _persistenceKey(key: string): string {
        return Object.prototype.hasOwnProperty.call(this._aliases, key)
            ? this._aliases[key]
            : `${BROWSER_EXTENSION_KV_PREFIX}${encodeURIComponent(this._extensionName)}/${encodeURIComponent(key)}`
    }

    async get<T = unknown>(key: string): Promise<T | undefined> {
        const persistenceKey = this._persistenceKey(key)
        const persistence = this._instance.persistence
        if (!persistence) {
            return this._memory.get(persistenceKey) as T | undefined
        }

        if (this._memory.has(persistenceKey)) {
            const memoryValue = this._memory.get(persistenceKey) as Property
            this._memory.delete(persistenceKey)
            if (isUndefined(persistence.props[persistenceKey])) {
                persistence._registerExtensionValue(persistenceKey, memoryValue)
            }
        }
        return persistence.props[persistenceKey] as T | undefined
    }

    async set(key: string, value: unknown): Promise<void> {
        const persistenceKey = this._persistenceKey(key)
        if (isNullish(value)) {
            await this.remove(key)
            return
        }

        const persistence = this._instance.persistence
        if (persistence) {
            this._memory.delete(persistenceKey)
            persistence._registerExtensionValue(persistenceKey, value as Property)
        } else {
            this._memory.set(persistenceKey, value)
        }
    }

    async remove(key: string): Promise<void> {
        const persistenceKey = this._persistenceKey(key)
        this._memory.delete(persistenceKey)
        this._instance.persistence?._unregisterExtensionValue(persistenceKey)
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

function appendRequestQuery(instance: PostHog, path: string, query: Record<string, string> | undefined): string {
    const target = /^\/?flags(?:\/|\?|$)/.test(path) ? 'flags' : 'api'
    const url = instance.requestRouter.endpointFor(target, path)
    const appendedQuery = { ...query }
    if (getQueryParam(url, 'token')) {
        delete appendedQuery.token
    } else if (!appendedQuery.token) {
        appendedQuery.token = instance.config.token
    }
    const queryString = formDataToQuery(appendedQuery)

    return queryString ? `${url}${url.indexOf('?') === -1 ? '?' : '&'}${queryString}` : url
}

function apiResponse(status: number, response?: { json?: unknown; text?: string }): ApiResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json(): Promise<unknown> {
            if (!isUndefined(response?.json)) {
                return response.json
            }
            if (response?.text) {
                return JSON.parse(response.text)
            }
            return undefined
        },
        async text(): Promise<string> {
            if (!isUndefined(response?.text)) {
                return response.text
            }
            return isUndefined(response?.json) ? '' : JSON.stringify(response.json)
        },
    }
}

/**
 * One browser-v1 host per PostHog instance. It owns shared extension lifecycle,
 * capability registration, and event streams while each extension receives a
 * separately namespaced Client adapter.
 */
export class BrowserExtensionHost implements Disposable {
    private readonly _extensions = new Map<string, RegisteredExtension>()
    private readonly _registrationOrder: RegisteredExtension[] = []
    private readonly _providers = new Map<ExtensionToken<unknown>, unknown>()
    private readonly _remoteConfigPublisher = new Publisher<BrowserCommonRemoteConfig>()
    private readonly _newSessionPublisher = new Publisher<NewSessionInfo>()
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
        return this._remoteConfigPublisher.listener
    }

    get onNewSession(): Listener<NewSessionInfo> {
        return this._newSessionPublisher.listener
    }

    add(extension: Extension, options: BrowserExtensionRegistrationOptions = {}): void {
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

        const adapter = new BrowserClientAdapter(this, extension.name, options.kvAliases ?? {})
        const registered = { extension, adapter, setupPromise: Promise.resolve() } satisfies RegisteredExtension
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
            this._remoteConfigPublisher.publish(config)
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
        this._remoteConfigPublisher.dispose()
        this._newSessionPublisher.dispose()
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
            this._newSessionPublisher.publish({ ...current, reason })
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
        extensionName: string,
        kvAliases: Record<string, string>
    ) {
        this.kv = new BrowserExtensionKeyValueStore(_host.instance, extensionName, kvAliases)
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

    async capture(
        event: string,
        properties?: Record<string, unknown> | null,
        options?: BrowserCommonCaptureOptions
    ): Promise<void> {
        const captureOptions: CaptureOptions = {
            timestamp: options?.timestamp,
            uuid: options?.uuid,
            $set: options?.set as Properties | undefined,
            $set_once: options?.setOnce as Properties | undefined,
        }
        this._host.instance.capture(event as EventName, properties as Properties | null | undefined, captureOptions)
    }

    registerDynamicEventProperties(producer: () => Record<string, unknown>): Disposable {
        return disposable(this._host.instance._registerExtensionEventProperties(producer))
    }

    async apiRequest(path: string, init: ApiRequestInit = {}): Promise<ApiResponse> {
        const requestOptions: QueuedRequestWithOptions = {
            method: init.method ?? 'POST',
            url: appendRequestQuery(this._host.instance, path, init.query),
            data: init.body as Record<string, unknown> | undefined,
            timeout: init.timeoutMs,
            noRetries: true,
            fireCallbackOnDrop: true,
            transport: init.unload ? 'sendBeacon' : undefined,
        }

        if (init.unload) {
            this._host.instance._send_request(requestOptions)
            return apiResponse(202)
        }

        return new Promise((resolve) => {
            requestOptions.callback = (response) => resolve(apiResponse(response.statusCode, response))
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
