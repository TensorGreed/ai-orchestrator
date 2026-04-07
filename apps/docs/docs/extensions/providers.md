# Provider SDK

LLM providers are added via adapter implementations in `packages/provider-sdk`.

## Adapter contract

Provider adapters expose:

- provider definition metadata
- non-stream generation
- optional streaming generation
- tool-call aware response handling

## Built-in providers

- `ollama`
- `openai_compatible`
- `openai`
- `azure_openai`
- `gemini` (basic)

## Add a new provider

1. Implement adapter in `packages/provider-sdk/src/providers`
2. Register in `packages/provider-sdk/src/index.ts`
3. Add provider id/type to shared types if needed
4. Add UI fields in node config modal
5. Add tests in workflow engine/provider package
