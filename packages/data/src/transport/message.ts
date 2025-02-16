import {createTraceId} from '../context.js';
import type {ErrorCode} from '../errors.js';
import type {Brand} from '../utils.js';

export type MessageId = Brand<string, 'message_id'>;

export function createMessageId(): MessageId {
    return createTraceId() as MessageId;
}

export interface MessageHeaders {
    readonly auth?: string | undefined;
    readonly traceparent: string;
    readonly tracestate: string;
}

export interface BaseMessage<TType extends string> {
    readonly type: TType;
    readonly id: MessageId;
    readonly headers: MessageHeaders;
}

export interface RequestMessage extends BaseMessage<'request'> {
    readonly payload: {
        name: string;
        arg: any;
    };
}

export interface CancelMessage extends BaseMessage<'cancel'> {
    readonly requestId: MessageId;
    readonly reason: string;
}

export interface BaseResponsePayload<TType extends string> {
    readonly type: TType;
}

export interface SuccessResponsePayload extends BaseResponsePayload<'success'> {
    readonly result: unknown;
}

export interface ErrorResponsePayload extends BaseResponsePayload<'error'> {
    readonly message: string;
    readonly code: ErrorCode;
}

export type ResponsePayload = SuccessResponsePayload | ErrorResponsePayload;

export interface ResponseMessage extends BaseMessage<'response'> {
    readonly requestId: MessageId;
    readonly payload: ResponsePayload;
}

export type Message = RequestMessage | CancelMessage | ResponseMessage;
