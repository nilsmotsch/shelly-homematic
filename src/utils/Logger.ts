import * as winston from 'winston';

interface LogConfig {
  level?: string;
  file?: string;
}

let logger: winston.Logger;

export function initLogger(config?: LogConfig): winston.Logger {
  // File OR console, never both: as a daemon, rc.d redirects stdout into
  // the same log file (to capture crashes), so a simultaneous Console
  // transport would duplicate every line.
  const transports: winston.transport[] = config?.file
    ? [
        new winston.transports.File({
          filename: config.file,
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
          ),
        }),
      ]
    : [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
          ),
        }),
      ];

  logger = winston.createLogger({
    level: config?.level || 'info',
    transports,
  });

  return logger;
}

export function getLogger(): winston.Logger {
  if (!logger) {
    return initLogger();
  }
  return logger;
}
