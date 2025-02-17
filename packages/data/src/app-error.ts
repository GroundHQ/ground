import {type NestedAttributeMap} from './context.js';

// eslint-disable-next-line no-restricted-globals
export class AppError extends Error {
    constructor(message: string, options?: {cause?: unknown}) {
        super(message, options);
    }

    toJSON(): NestedAttributeMap {
        let result: NestedAttributeMap = {
            message: `${this.constructor.name} (${this.name}): ${this.message}`,
        };
        if (this.stack) {
            result.stack = this.stack.trim().startsWith('at')
                ? this.stack
                : this.stack.split('\n').slice(1).join('\n');
        }

        if (this.cause) {
            if (this.cause instanceof AppError) {
                result = {
                    ...result,
                    cause: this.cause.toJSON(),
                };
            } else {
                result = {
                    ...result,
                    cause: JSON.stringify(this.cause),
                };
            }
        }

        return result;
    }
}
