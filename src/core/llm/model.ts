import Anthropic from "@anthropic-ai/sdk";

export interface LLMModel {
    createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[], isJSON: boolean, isReasoning?: boolean): Promise<string>;
    getModel(): string;
}