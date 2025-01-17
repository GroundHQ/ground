export interface Logger {
    trace(message: string): void;
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: any): void;
}

export class ConsoleLogger implements Logger {
    trace(message: string): void {
        console.trace(message);
    }
    debug(message: string): void {
        console.debug(message);
    }
    info(message: string): void {
        console.info(message);
    }
    warn(message: string): void {
        console.warn(message);
    }
    error(message: string, error?: any): void {
        if (error) {
            console.error(message, error);
        } else {
            console.error(message);
        }
    }
}
