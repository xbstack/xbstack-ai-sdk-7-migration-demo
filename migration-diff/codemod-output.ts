import { generateText, streamText } from 'ai';

export async function runGenerate(model: Parameters<typeof generateText>[0]['model']) {
  return generateText({
    model,
    instructions: 'Use tools before answering.',
    prompt: 'Check the order status.',
    onFinish({ steps }) {
      console.log('finished steps', steps.length);
    },
  });
}

export function runStream(model: Parameters<typeof streamText>[0]['model']) {
  const result = streamText({
    model,
    instructions: 'Stream a compact answer.',
    prompt: 'Say hello.',
  });

  return result.stream;
}
