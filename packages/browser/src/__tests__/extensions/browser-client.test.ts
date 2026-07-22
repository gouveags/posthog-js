import type { Client, Extension, ExtensionToken, NewSessionInfo } from '@posthog/browser-common'

import { logger } from '@posthog/browser-common/utils/logger'
import { SimpleEventEmitter } from '@posthog/browser-common/utils/simple-event-emitter'

import { AUTOCAPTURE_DISABLED_SERVER_SIDE, DEVICE_ID } from '../../constants'
import { BrowserExtensionHost } from '../../extensions/browser-client'
import type { PostHog } from '../../posthog-core'
import type { PostHogPersistence } from '../../posthog-persistence'
import type { CaptureOptions, Properties, QueuedRequestWithOptions, RemoteConfigResult } from '../../types'
import { createPosthogInstance } from '../helpers/posthog-instance'

interface MockPostHog extends PostHog {
    emitSession(
        sessionId: string,
        windowId: string,
        changeReason?: {
            noSessionId: boolean
            activityTimeout: boolean
            sessionPastMaximumLength: boolean
            crossTabAdoption?: boolean
        }
    ): void
    emitEvent(event: string, properties?: Properties): void
}

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function createMockPostHog(
    options: {
        remoteConfigResult?: RemoteConfigResult
        flagsDisabled?: boolean
        emitCurrentSession?: boolean
    } = {}
): MockPostHog {
    const props: Properties = {
        distinct_id: 'distinct-id',
        [DEVICE_ID]: 'anonymous-id',
        $groups: { organization: 'org-id' },
    }
    const eventHandlers = new Set<(event: { event: string; properties: Properties }) => void>()
    let sessionHandler:
        | ((
              sessionId: string,
              windowId: string,
              changeReason?: {
                  noSessionId: boolean
                  activityTimeout: boolean
                  sessionPastMaximumLength: boolean
                  crossTabAdoption?: boolean
              }
          ) => void)
        | undefined

    const persistence = {
        props,
        register: jest.fn((values: Properties) => Object.assign(props, values)),
        unregister: jest.fn((key: string) => delete props[key]),
    } as unknown as PostHogPersistence

    const instance = {
        config: { token: 'test-token', debug: false },
        persistence,
        _lastRemoteConfig: options.remoteConfigResult,
        _shouldDisableFlags: jest.fn(() => options.flagsDisabled ?? false),
        get_distinct_id: jest.fn(() => props.distinct_id as string),
        get_property: jest.fn((key: string) => props[key]),
        getGroups: jest.fn(() => props.$groups),
        sessionManager: {
            checkAndGetSessionAndWindowId: jest.fn(() => ({
                sessionId: 'session-id',
                windowId: 'window-id',
                sessionStartTimestamp: 123,
            })),
        },
        capture: jest.fn(),
        _registerExtensionEventProperties: jest.fn(() => jest.fn()),
        requestRouter: {
            endpointFor: jest.fn((target: string, path: string) => `https://${target}.example.com${path}`),
        },
        _send_request: jest.fn(),
        _internalEventEmitter: new SimpleEventEmitter(),
        on: jest.fn((_event: string, handler: (event: { event: string; properties: Properties }) => void) => {
            eventHandlers.add(handler)
            return () => eventHandlers.delete(handler)
        }),
        onSessionId: jest.fn((handler) => {
            sessionHandler = handler
            if (options.emitCurrentSession !== false) {
                handler('session-id', 'window-id')
            }
            return () => {
                sessionHandler = undefined
            }
        }),
        emitSession(sessionId, windowId, changeReason) {
            sessionHandler?.(sessionId, windowId, changeReason)
        },
        emitEvent(event, properties = {}) {
            eventHandlers.forEach((handler) => handler({ event, properties }))
        },
    } as unknown as MockPostHog

    return instance
}

function testExtension(
    name: string,
    setup: (client: Client) => void | Promise<void>,
    dispose: () => void | Promise<void> = jest.fn(),
    provides?: readonly ExtensionToken<unknown>[]
): Extension {
    return { name, provides, setup, dispose }
}

describe('BrowserExtensionHost', () => {
    it('provides an extension-scoped Client with identity, session, capture, and logger capabilities', async () => {
        const instance = createMockPostHog()
        const host = new BrowserExtensionHost(instance)
        let client: Client | undefined
        host.add(testExtension('test', (value) => (client = value)))

        expect(client?.distinctId).toBe('distinct-id')
        expect(client?.anonymousId).toBe('anonymous-id')
        expect(client?.groups).toEqual({ organization: 'org-id' })
        expect(client?.session).toEqual({
            sessionId: 'session-id',
            windowId: 'window-id',
            sessionStartTimestamp: 123,
        })
        expect(instance.sessionManager?.checkAndGetSessionAndWindowId).toHaveBeenCalledWith(true)
        expect(client?.logger).toBeDefined()

        const timestamp = new Date('2026-01-01T00:00:00Z')
        await client?.capture(
            'test-event',
            { explicit: true },
            { timestamp, uuid: 'test-uuid', set: { plan: 'paid' }, setOnce: { source: 'test' } }
        )
        expect(instance.capture).toHaveBeenCalledWith('test-event', { explicit: true }, {
            timestamp,
            uuid: 'test-uuid',
            $set: { plan: 'paid' },
            $set_once: { source: 'test' },
        } satisfies CaptureOptions)

        await host.dispose()
    })

    it('falls back to the distinct id and an empty session in limited environments', async () => {
        const instance = createMockPostHog()
        instance.get_property = jest.fn(() => undefined)
        instance.sessionManager!.checkAndGetSessionAndWindowId = jest.fn(() => {
            throw new Error('cookieless')
        })
        const host = new BrowserExtensionHost(instance)
        let client: Client | undefined
        host.add(testExtension('test', (value) => (client = value)))

        expect(client?.anonymousId).toBe('distinct-id')
        expect(client?.session).toEqual({ sessionId: '', windowId: '', sessionStartTimestamp: 0 })
        await host.dispose()
    })

    it('reads, writes, and removes persistence keys directly', async () => {
        const instance = createMockPostHog()
        const host = new BrowserExtensionHost(instance)
        let client: Client | undefined
        host.add(testExtension('test', (value) => (client = value)))

        const key = '$extension_state'
        instance.persistence!.props[key] = { prepopulated: true }
        expect(client?.kv.get(key)).toEqual({ prepopulated: true })

        expect(client?.kv.set(key, { enabled: true })).toBeUndefined()
        expect(instance.persistence?.register).toHaveBeenCalledWith({ [key]: { enabled: true } })
        expect(instance.persistence?.props[key]).toEqual({ enabled: true })

        instance.persistence!.props[key] = { externallyUpdated: true }
        expect(await client?.kv.get(key)).toEqual({ externallyUpdated: true })

        await client?.kv.remove(key)
        expect(instance.persistence?.unregister).toHaveBeenCalledWith(key)
        expect(instance.persistence?.props[key]).toBeUndefined()
        await host.dispose()
    })

    it('registers capability tokens before setup and removes failed registrations', async () => {
        interface Capability {
            value: string
        }
        const token: ExtensionToken<Capability> = { name: 'capability' }
        const instance = createMockPostHog()
        const host = new BrowserExtensionHost(instance)
        const provider = testExtension(
            'provider',
            (client) => {
                expect(client.getExtension(token)).toBe(provider)
                return Promise.reject(new Error('setup failed'))
            },
            jest.fn(),
            [token]
        )
        const error = jest.spyOn(host.logger, 'error').mockImplementation()

        host.add(provider)
        expect(host.getExtension(token)).toBe(provider)
        await flushPromises()
        expect(host.getExtension(token)).toBeUndefined()
        expect(provider.dispose).toHaveBeenCalled()
        expect(error).toHaveBeenCalledWith('Failed to set up browser extension "provider"', expect.any(Error))

        const replacement = testExtension('provider', jest.fn(), jest.fn(), [token])
        host.add(replacement)
        expect(host.getExtension(token)).toBe(replacement)
        await host.dispose()
    })

    it('rejects duplicate extension names and token collisions', async () => {
        const token: ExtensionToken<unknown> = { name: 'shared' }
        const host = new BrowserExtensionHost(createMockPostHog())
        host.add(testExtension('first', jest.fn(), jest.fn(), [token]))

        expect(() => host.add(testExtension('first', jest.fn()))).toThrow('already registered')
        expect(() => host.add(testExtension('second', jest.fn(), jest.fn(), [token]))).toThrow(
            'token "shared" is already registered'
        )
        await host.dispose()
    })

    it('exposes current remote config, waits for the first outcome, and only publishes successes', async () => {
        const host = new BrowserExtensionHost(createMockPostHog())
        let client: Client | undefined
        host.add(testExtension('test', (value) => (client = value)))
        const changes: unknown[] = []
        client?.onRemoteConfig((config) => changes.push(config))

        const pending = client?.getRemoteConfig()
        host.handleRemoteConfig({ ok: false })
        await expect(pending).resolves.toBeUndefined()
        expect(changes).toEqual([])
        await expect(client?.getRemoteConfig()).resolves.toBeUndefined()

        host.handleRemoteConfig({ ok: true, config: { supportedCompression: [], marker: 'current' } as any })
        expect(changes).toEqual([expect.objectContaining({ marker: 'current' })])
        await expect(client?.getRemoteConfig()).resolves.toEqual(expect.objectContaining({ marker: 'current' }))
        await host.dispose()
    })

    it('uses a cached remote result and resolves immediately when remote config is disabled', async () => {
        const cachedHost = new BrowserExtensionHost(
            createMockPostHog({
                remoteConfigResult: {
                    ok: true,
                    config: { supportedCompression: [], cached: true } as any,
                },
            })
        )
        let cachedClient: Client | undefined
        cachedHost.add(testExtension('cached', (client) => (cachedClient = client)))
        await expect(cachedClient?.getRemoteConfig()).resolves.toEqual(expect.objectContaining({ cached: true }))
        await cachedHost.dispose()

        const disabledHost = new BrowserExtensionHost(createMockPostHog({ flagsDisabled: true }))
        let disabledClient: Client | undefined
        disabledHost.add(testExtension('disabled', (client) => (disabledClient = client)))
        await expect(disabledClient?.getRemoteConfig()).resolves.toBeUndefined()
        await disabledHost.dispose()
    })

    it('adapts captured-event and new-session listeners and disposes subscriptions', async () => {
        const instance = createMockPostHog()
        const host = new BrowserExtensionHost(instance)
        let client: Client | undefined
        host.add(testExtension('test', (value) => (client = value)))
        const events: unknown[] = []
        const sessions: NewSessionInfo[] = []
        const eventSubscription = client!.onEvent((event) => events.push(event))
        const sessionSubscription = client!.onNewSession((session) => sessions.push(session))

        instance.emitEvent('captured', { answer: 42 })
        instance.emitSession('idle-session', 'idle-window', {
            noSessionId: false,
            activityTimeout: true,
            sessionPastMaximumLength: false,
        })
        instance.emitSession('window-only', 'new-window', {
            noSessionId: false,
            activityTimeout: false,
            sessionPastMaximumLength: false,
        })
        instance.emitSession('cross-tab-session', 'cross-tab-window', {
            noSessionId: false,
            activityTimeout: false,
            sessionPastMaximumLength: false,
            crossTabAdoption: true,
        })
        expect(events).toEqual([{ event: 'captured', properties: { answer: 42 } }])
        expect(sessions.map(({ reason }) => reason)).toEqual(['idleTimeout', 'crossTabAdoption'])

        eventSubscription.dispose()
        sessionSubscription.dispose()
        instance.emitEvent('ignored')
        instance.emitSession('max-session', 'max-window', {
            noSessionId: false,
            activityTimeout: false,
            sessionPastMaximumLength: true,
        })
        expect(events).toHaveLength(1)
        expect(sessions).toHaveLength(2)
        await host.dispose()
    })

    it('maps initial and reset session creation when no current session exists', async () => {
        const instance = createMockPostHog({ emitCurrentSession: false })
        const host = new BrowserExtensionHost(instance)
        let client: Client | undefined
        host.add(testExtension('test', (value) => (client = value)))
        const reasons: string[] = []
        client?.onNewSession(({ reason }) => reasons.push(reason))
        const noSessionReason = {
            noSessionId: true,
            activityTimeout: false,
            sessionPastMaximumLength: false,
        }

        instance.emitSession('initial', 'window', noSessionReason)
        host.markReset()
        instance.emitSession('reset', 'window', noSessionReason)
        expect(reasons).toEqual(['initial', 'reset'])
        await host.dispose()
    })

    it('delegates dynamic properties and returns an idempotent disposable', async () => {
        const instance = createMockPostHog()
        const remove = jest.fn()
        instance._registerExtensionEventProperties = jest.fn(() => remove)
        const host = new BrowserExtensionHost(instance)
        let client: Client | undefined
        host.add(testExtension('test', (value) => (client = value)))
        const producer = () => ({ dynamic: true })

        const registration = client!.registerDynamicEventProperties(producer)
        expect(instance._registerExtensionEventProperties).toHaveBeenCalledWith(producer)
        registration.dispose()
        registration.dispose()
        expect(remove).toHaveBeenCalledTimes(1)
        await host.dispose()
    })

    it('adapts API requests, dropped requests, flags routing, query/auth, and unload sends', async () => {
        const instance = createMockPostHog()
        const send = instance._send_request as jest.MockedFunction<(options: QueuedRequestWithOptions) => void>
        send.mockImplementation((options) =>
            options.callback?.({ statusCode: 201, json: { created: true }, text: '{"created":true}' })
        )
        const host = new BrowserExtensionHost(instance)
        let client: Client | undefined
        host.add(testExtension('test', (value) => (client = value)))

        const response = await client!.apiRequest('/flags/?existing=yes&token=existing-token', {
            method: 'GET',
            query: { extra: 'value', token: 'duplicate-token' },
            timeoutMs: 321,
        })
        expect(response.statusCode).toBe(201)
        expect(response.json).toEqual({ created: true })
        expect(response.text).toBe('{"created":true}')
        expect(instance.requestRouter.endpointFor).toHaveBeenCalledWith(
            'flags',
            '/flags/?existing=yes&token=existing-token'
        )
        expect(send.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                method: 'GET',
                timeout: 321,
                noRetries: true,
                fireCallbackOnDrop: true,
                url: expect.stringContaining('token=existing-token'),
            })
        )
        expect(send.mock.calls[0][0].url).toContain('existing=yes')
        expect(send.mock.calls[0][0].url).toContain('extra=value')
        expect(send.mock.calls[0][0].url?.match(/token=/g)).toHaveLength(1)

        const requestError = new Error('network failure')
        send.mockImplementationOnce((options) => options.callback?.({ statusCode: 0, error: requestError }))
        const dropped = await client!.apiRequest('/api/surveys/')
        expect(dropped.statusCode).toBe(0)
        expect(dropped.error).toBe(requestError)
        expect(send.mock.calls[1][0].url).toContain('token=test-token')

        send.mockImplementationOnce(() => undefined)
        const unload = await client!.apiRequest('/s/', { method: 'POST', body: { events: [] }, unload: true })
        expect(unload.statusCode).toBe(202)
        expect(unload.json).toBeUndefined()
        expect(unload.text).toBeUndefined()
        expect(send.mock.calls.at(-1)?.[0]).toEqual(
            expect.objectContaining({ transport: 'sendBeacon', data: { events: [] } })
        )
        await host.dispose()
    })

    it('coordinates setup rejection with concurrent disposal exactly once', async () => {
        let rejectSetup: ((error: Error) => void) | undefined
        let resolveDisposal: (() => void) | undefined
        const extensionDispose = jest.fn(() => new Promise<void>((resolve) => (resolveDisposal = resolve)))
        const host = new BrowserExtensionHost(createMockPostHog())
        host.add(
            testExtension(
                'deferred-failure',
                () => new Promise<void>((_resolve, reject) => (rejectSetup = reject)),
                extensionDispose
            )
        )

        const firstDispose = host.dispose()
        const secondDispose = host.dispose()
        expect(firstDispose).toBe(secondDispose)
        rejectSetup?.(new Error('setup failed'))
        await flushPromises()
        expect(extensionDispose).toHaveBeenCalledTimes(1)
        resolveDisposal?.()
        await Promise.all([firstDispose, secondDispose])
        expect(extensionDispose).toHaveBeenCalledTimes(1)
    })

    it('disposes extensions in reverse registration order and is idempotent', async () => {
        const order: string[] = []
        const instance = createMockPostHog()
        const host = new BrowserExtensionHost(instance)
        host.add(testExtension('first', jest.fn(), () => order.push('first')))
        host.add(testExtension('second', jest.fn(), () => order.push('second')))

        await host.dispose()
        await host.dispose()
        expect(order).toEqual(['second', 'first'])
        expect(instance.onSessionId).toHaveBeenCalledTimes(1)
        expect(() => host.add(testExtension('late', jest.fn()))).toThrow('disposed')
    })

    it('uses the existing persistence policy for direct keys', async () => {
        const captured: Properties[] = []
        const posthog = await createPosthogInstance(undefined, {
            before_send: (event) => {
                if (event) {
                    captured.push(event.properties)
                }
                return event
            },
        })
        let client: Client | undefined
        posthog._getBrowserExtensionHost().add(testExtension('test', (value) => (client = value)))

        await client?.kv.set(AUTOCAPTURE_DISABLED_SERVER_SIDE, false)
        posthog.capture('kv-exposure')

        expect(captured.at(-1)).toHaveProperty(AUTOCAPTURE_DISABLED_SERVER_SIDE, false)
        await posthog.shutdown()
    })

    it('bridges PostHog remote config, finalized events, reset sessions, and shutdown', async () => {
        const posthog = await createPosthogInstance(undefined, { before_send: (event) => event })
        const host = posthog._getBrowserExtensionHost()
        const extensionDispose = jest.fn()
        let client: Client | undefined
        host.add(testExtension('lifecycle', (value) => (client = value), extensionDispose))
        const remoteConfigs: unknown[] = []
        const events: Array<{ event: string; properties: Record<string, unknown> }> = []
        const sessionReasons: string[] = []
        client?.onRemoteConfig((config) => remoteConfigs.push(config))
        client?.onEvent((event) => events.push(event))
        client?.onNewSession(({ reason }) => sessionReasons.push(reason))

        posthog.capture('finalized-event', { explicit: true })
        expect(events.at(-1)).toEqual({
            event: 'finalized-event',
            properties: expect.objectContaining({ explicit: true, token: posthog.config.token }),
        })

        const body = document.body
        body.remove()
        jest.useFakeTimers()
        try {
            posthog._onRemoteConfig({
                ok: true,
                config: { supportedCompression: [], lifecycle: true } as any,
            })
            expect(remoteConfigs).toEqual([expect.objectContaining({ lifecycle: true })])
            document.documentElement.appendChild(body)
            jest.advanceTimersByTime(500)
            expect(remoteConfigs).toHaveLength(1)
        } finally {
            if (!document.body) {
                document.documentElement.appendChild(body)
            }
            jest.useRealTimers()
        }

        await client?.kv.set('state', 'before-reset')
        await client?.kv.set(AUTOCAPTURE_DISABLED_SERVER_SIDE, false)
        posthog.reset()
        expect(await client?.kv.get('state')).toBeUndefined()
        expect(await client?.kv.get(AUTOCAPTURE_DISABLED_SERVER_SIDE)).toBeUndefined()
        posthog.capture('after-reset')
        expect(sessionReasons).toContain('reset')

        await posthog.shutdown()
        expect(extensionDispose).toHaveBeenCalledTimes(1)
    })
})

describe('PostHog extension dynamic properties', () => {
    it('merges producers before explicit properties, disposes them, and isolates producer errors', async () => {
        const beforeSend = jest.fn((event) => event)
        const posthog = await createPosthogInstance(undefined, { before_send: beforeSend })
        const error = jest.spyOn(logger, 'error').mockImplementation()
        const calculateEventProperties = jest.spyOn(posthog, 'calculateEventProperties')
        const removeDynamic = posthog._registerExtensionEventProperties(() => ({
            dynamic: 'value',
            overridden: 'dynamic',
            overriddenWithUndefined: 'dynamic',
        }))
        posthog._registerExtensionEventProperties(() => {
            throw new Error('producer failed')
        })
        const duplicateProducer = jest.fn(() => ({ duplicated: true }))
        const removeFirstDuplicate = posthog._registerExtensionEventProperties(duplicateProducer)
        posthog._registerExtensionEventProperties(duplicateProducer)

        posthog.capture('with-dynamic', { overridden: 'explicit', overriddenWithUndefined: undefined })
        expect(calculateEventProperties.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                dynamic: 'value',
                overridden: 'explicit',
                overriddenWithUndefined: undefined,
            })
        )
        expect(beforeSend).toHaveBeenLastCalledWith(
            expect.objectContaining({
                properties: expect.objectContaining({ dynamic: 'value', overridden: 'explicit' }),
            })
        )

        expect(duplicateProducer).toHaveBeenCalledTimes(2)
        removeFirstDuplicate()
        posthog.capture('with-one-duplicate')
        expect(duplicateProducer).toHaveBeenCalledTimes(3)

        removeDynamic()
        posthog.capture('without-dynamic')
        expect(beforeSend).toHaveBeenLastCalledWith(
            expect.objectContaining({ properties: expect.not.objectContaining({ dynamic: 'value' }) })
        )
        expect(error).toHaveBeenCalled()
        await posthog.shutdown()
    })
})
