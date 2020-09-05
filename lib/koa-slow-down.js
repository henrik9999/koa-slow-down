"use strict";
const defaults = require("defaults");
const MemoryStore = require("./memory-store");

function SlowDown(options) {
  options = defaults(options, {
    // window, delay, and max apply per-key unless global is set to true
    windowMs: 60 * 1000, // milliseconds - how long to keep records of requests in memory
    delayAfter: 1, // how many requests to allow through before starting to delay responses
    delayMs: 1000, // milliseconds - base delay applied to the response - multiplied by number of recent hits for the same key.
    maxDelayMs: Infinity, // milliseconds - maximum delay to be applied to the response, regardless the request count. Infinity means that the delay will grow continuously and unboundedly
    skipFailedRequests: false, // Do not count failed requests (status >= 400)
    skipSuccessfulRequests: false, // Do not count successful requests (status < 400)
    // allows to create custom keys (by default user IP is used)
    keyGenerator: function (ctx) {
      return ctx.ip;
    },
    skip: function () {
      return false;
    },
    onLimitReached: function () {},
  });

  // store to use for persisting rate limit data
  options.store = options.store || new MemoryStore(options.windowMs);

  // ensure that the store has the incr method
  if (
    typeof options.store.incr !== "function" ||
    typeof options.store.resetKey !== "function" ||
    (options.skipFailedRequests &&
      typeof options.store.decrement !== "function")
  ) {
    throw new Error("The store is not valid.");
  }
  function slowDown(ctx, next) {
    return new Promise((resolve) => {
      if (options.skip(ctx)) {
        return resolve(next());
      }

      const key = options.keyGenerator(ctx);

      options.store.incr(key, function (err, current, resetTime) {
        if (err) {
          return resolve(next(err));
        }

        let delay = 0;

        const delayAfter =
          typeof options.delayAfter === "function"
            ? options.delayAfter(ctx)
            : options.delayAfter;

        if (current > delayAfter) {
          const unboundedDelay = (current - delayAfter) * options.delayMs;
          delay = Math.min(unboundedDelay, options.maxDelayMs);
        }

        ctx.req.slowDown = {
          limit: delayAfter,
          current: current,
          remaining: Math.max(delayAfter - current, 0),
          resetTime: resetTime,
          delay: delay,
        };

        if (current - 1 === delayAfter) {
          options.onLimitReached(ctx, options);
        }

        if (options.skipFailedRequests || options.skipSuccessfulRequests) {
          let decremented = false;
          const decrementKey = () => {
            if (!decremented) {
              options.store.decrement(key);
              decremented = true;
            }
          };

          if (options.skipFailedRequests) {
            ctx.res.on("finish", function () {
              if (ctx.response.status >= 400) {
                decrementKey();
              }
            });

            ctx.res.on("close", () => {
              if (!ctx.res.finished) {
                decrementKey();
              }
            });

            ctx.res.on("error", () => decrementKey());
          }

          if (options.skipSuccessfulRequests) {
            ctx.res.on("finish", function () {
              if (ctx.response.status < 400) {
                options.store.decrement(key);
              }
            });
          }
        }
        if (delay !== 0) {
          setTimeout(() => resolve(next()), delay);
        } else {
          resolve(next());
        }
      });
    });
  }

  slowDown.resetKey = options.store.resetKey.bind(options.store);

  return slowDown;
}

module.exports = SlowDown;
