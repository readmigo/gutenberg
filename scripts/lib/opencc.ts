import * as OpenCC from 'opencc-js';

const converter = OpenCC.Converter({ from: 'tw', to: 'cn' });

export function traditionalToSimplified(text: string): string {
  return converter(text);
}

export function isTraditional(text: string): boolean {
  const sample = text.slice(0, 2000);
  const converted = converter(sample);
  let diffCount = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] !== converted[i]) diffCount++;
  }
  return sample.length > 0 && diffCount / sample.length > 0.02;
}
