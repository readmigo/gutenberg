declare module 'opencc-js' {
  function Converter(options: { from: string; to: string }): (text: string) => string;
}
