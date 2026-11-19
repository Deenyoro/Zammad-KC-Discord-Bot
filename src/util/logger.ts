import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Credentials must not reach the logs even if a request or options object
  // is logged by mistake.
  redact: {
    paths: [
      "authorization", "*.authorization", "headers.authorization", "*.headers.authorization",
      "Authorization", "*.Authorization", "headers.Authorization", "*.headers.Authorization",
      "apiKey", "*.apiKey", "api_key", "*.api_key", "token", "*.token",
    ],
    censor: "[redacted]",
  },
  ...(isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});
