type LogLevel = "log" | "warn" | "error" | "debug";
type LogMethod = (message: string, ...details: unknown[]) => void;
type LoggerTarget = { console?: Pick<Console, LogLevel> };

const accent = "#2bfcf3";
const badgeStyle = `color:#000;background:${accent};border-radius:999px;padding:1px 6px;font-weight:600;`;

export function createLogger(
	target: LoggerTarget = globalThis,
): Record<LogLevel, LogMethod> {
	const write = (
		level: LogLevel,
		message: string,
		details: unknown[],
	): void => {
		target.console?.[level](
			"%cFckCensor%c %s",
			badgeStyle,
			"",
			message.replace(/^\[FckCensor\]\s*/, ""),
			...details,
		);
	};
	return {
		log: (message, ...details) => write("log", message, details),
		warn: (message, ...details) => write("warn", message, details),
		error: (message, ...details) => write("error", message, details),
		debug: (message, ...details) => write("debug", message, details),
	};
}

export const logger = createLogger();
