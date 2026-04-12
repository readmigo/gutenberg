export interface CoverPromptInput {
  title: string;
  author: string;
  dynasty?: string;
  subjects?: string[];
  language: string;
}

function getDynastyStyle(dynasty?: string): string {
  if (!dynasty) return 'classical Chinese ink wash painting, elegant brushwork';

  const dynastyStyleMap: Record<string, string> = {
    '先秦': 'ancient Chinese bronze and jade aesthetic, archaic oracle bone motifs',
    '两汉': 'Han dynasty lacquerware style, flowing silk painting aesthetic',
    '魏晋南北朝': 'ethereal landscape, bamboo forest, scholar-recluse atmosphere',
    '唐': 'Tang dynasty golden age, vibrant colors, peony and crane motifs',
    '宋': 'Song dynasty refined ink wash painting, misty mountains, minimalist elegance',
    '元': 'Yuan dynasty steppe meets Chinese garden, bold brushwork',
    '明': 'Ming dynasty blue and white porcelain aesthetic, garden architecture',
    '清': 'Qing dynasty elaborate detail, imperial garden, traditional painting',
    '民国': 'Republican era art deco meets Chinese modernism, vintage book cover style',
  };

  return dynastyStyleMap[dynasty] ?? 'classical Chinese ink wash painting, elegant brushwork';
}

export function generateCoverPrompt(input: CoverPromptInput): string {
  const { title, author, dynasty, subjects, language } = input;
  const style = getDynastyStyle(dynasty);

  const parts: string[] = [
    `A book cover illustration for "${title}" by ${author}${dynasty ? `, ${dynasty} period` : ''}.`,
    `Style: ${style}.`,
    'No text, no letters, no words, no title on the image.',
    'Portrait orientation, 1600x2400 pixels, high resolution.',
    'Rich color palette with harmonious tones, detailed and atmospheric composition.',
  ];

  if (subjects && subjects.length > 0) {
    parts.push(`Thematic elements: ${subjects.join(', ')}.`);
  }

  return parts.join(' ');
}
