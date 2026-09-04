function isObjectLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isThenable(value) {
  return (
    isObjectLike(value) &&
    typeof value.then === 'function'
  );
}

function addUsage(sink, message) {
  const usage = message?.usage;
  if (usage === null || typeof usage !== 'object') {
    return;
  }

  const fields = [
    ['input', 'input'],
    ['output', 'output'],
    ['total', 'totalTokens'],
  ];
  for (const [sinkField, usageField] of fields) {
    const value = usage[usageField];
    if (typeof value === 'number' && Number.isFinite(value)) {
      sink.auxiliaryTokens[sinkField] += value;
    }
  }
}

export function createBenchmarkTelemetry() {
  const sink = {
    steerAccepted: 0,
    followUpAccepted: 0,
    blocksReturned: 0,
    blockedToolCallIds: [],
    interventions: [],
    auxiliaryModelCalls: 0,
    auxiliaryTokens: { input: 0, output: 0, total: 0 },
    appendEntryCount: 0,
    handlerThrows: 0,
    persistedPayloads: [],
  };

  const wrappedContexts = new WeakMap();
  const wrappedModelRegistries = new WeakMap();
  // Attribute phases only during each handler's synchronous invocation; keeping a shared stack across thenables would mis-attribute interleaved handlers.
  let currentHandlerName;

  function observe(eventName, value, event) {
    if (
      eventName === 'tool_call' &&
      value !== null &&
      typeof value === 'object' &&
      value.block === true
    ) {
      sink.blocksReturned += 1;
      if (typeof event?.toolCallId === 'string') {
        sink.blockedToolCallIds.push(event.toolCallId);
      }
      sink.interventions.push({ kind: 'block', phase: 'tool_call' });
    }
  }

  function invokeObserved(eventName, invoke, event) {
    const previousHandlerName = currentHandlerName;
    currentHandlerName = eventName;
    let result;
    try {
      result = invoke();
    } catch (error) {
      currentHandlerName = previousHandlerName;
      sink.handlerThrows += 1;
      throw error;
    }
    currentHandlerName = previousHandlerName;

    try {
      if (isThenable(result)) {
        return result.then(
          (value) => {
            observe(eventName, value, event);
            return value;
          },
          (error) => {
            sink.handlerThrows += 1;
            throw error;
          },
        );
      }
      observe(eventName, result, event);
      return result;
    } catch (error) {
      sink.handlerThrows += 1;
      throw error;
    }
  }

  function wrapModelRegistry(modelRegistry) {
    if (!isObjectLike(modelRegistry)) {
      return modelRegistry;
    }

    const cached = wrappedModelRegistries.get(modelRegistry);
    if (cached !== undefined) {
      return cached;
    }

    const wrapped = new Proxy(modelRegistry, {
      get(target, prop) {
        if (prop !== 'complete') {
          return Reflect.get(target, prop, target);
        }

        return (...args) => {
          sink.auxiliaryModelCalls += 1;
          const complete = Reflect.get(target, prop, target);
          const result = Reflect.apply(complete, target, args);
          if (isThenable(result)) {
            return result.then((message) => {
              addUsage(sink, message);
              return message;
            });
          }

          addUsage(sink, result);
          return result;
        };
      },
    });
    wrappedModelRegistries.set(modelRegistry, wrapped);
    return wrapped;
  }

  function wrapCtx(ctx) {
    if (!isObjectLike(ctx)) {
      return ctx;
    }

    const cached = wrappedContexts.get(ctx);
    if (cached !== undefined) {
      return cached;
    }

    let modelRegistryRead = false;
    let cachedModelRegistry;
    const wrapped = new Proxy(ctx, {
      get(target, prop) {
        if (prop === 'modelRegistry') {
          if (!modelRegistryRead) {
            cachedModelRegistry = wrapModelRegistry(
              Reflect.get(target, prop, target),
            );
            modelRegistryRead = true;
          }
          return cachedModelRegistry;
        }
        return Reflect.get(target, prop, target);
      },
    });
    wrappedContexts.set(ctx, wrapped);
    return wrapped;
  }

  function wrapExtensionApi(pi) {
    return new Proxy(pi, {
      get(target, prop) {
        if (prop === 'on') {
          return (name, handler) => {
            const on = Reflect.get(target, prop, target);
            return Reflect.apply(on, target, [
              name,
              (event, ctx) =>
                invokeObserved(name, () => handler(event, wrapCtx(ctx)), event),
            ]);
          };
        }

        if (prop === 'registerCommand') {
          return (name, spec) => {
            const handler = spec?.handler;
            if (typeof handler !== 'function') {
              const registerCommand = Reflect.get(target, prop, target);
              return Reflect.apply(registerCommand, target, [name, spec]);
            }

            const wrappedSpec = {
              ...spec,
              handler: (args, ctx) =>
                invokeObserved('command', () =>
                  Reflect.apply(handler, spec, [args, wrapCtx(ctx)]),
                ),
            };
            const registerCommand = Reflect.get(target, prop, target);
            return Reflect.apply(registerCommand, target, [name, wrappedSpec]);
          };
        }

        if (prop === 'sendUserMessage') {
          return (message, options) => {
            const sendUserMessage = Reflect.get(target, prop, target);
            const result = Reflect.apply(sendUserMessage, target, [
              message,
              options,
            ]);
            if (options?.deliverAs === 'steer') {
              sink.steerAccepted += 1;
              sink.interventions.push({
                kind: 'steer',
                phase: currentHandlerName ?? 'unknown',
              });
            } else if (options?.deliverAs === 'followUp') {
              sink.followUpAccepted += 1;
              sink.interventions.push({
                kind: 'follow-up',
                phase: currentHandlerName ?? 'unknown',
              });
            }
            return result;
          };
        }

        if (prop === 'appendEntry') {
          return (customType, record) => {
            sink.persistedPayloads.push({ customType, record });
            sink.appendEntryCount += 1;
            const appendEntry = Reflect.get(target, prop, target);
            return Reflect.apply(appendEntry, target, [customType, record]);
          };
        }

        return Reflect.get(target, prop, target);
      },
    });
  }

  return { sink, wrapExtensionApi };
}
