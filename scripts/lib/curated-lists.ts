/**
 * Curated book lists with Gutenberg IDs for priority-based discovery.
 *
 * Sources:
 * - Guardian's 100 Best Novels
 * - 1001 Books You Must Read Before You Die (public domain subset)
 * - Penguin Classics popular titles
 * - Most-taught classics in English education
 * - LibriVox most-downloaded (audio-ready)
 *
 * Gutenberg IDs sourced from gutendex.com cross-referencing.
 */

export interface CuratedEntry {
  gutenbergId: number;
  title: string;
  lists: string[]; // which curated lists this appears in
}

// Priority bonus per list membership
export const LIST_BONUS: Record<string, number> = {
  'multi-list-classic': 500,  // appears on 3+ canonical lists
  'guardian-100': 300,
  '1001-books': 200,
  'penguin-classics': 200,
  'most-taught': 400,
  'librivox-popular': 150,
};

/**
 * Curated Gutenberg IDs with list memberships.
 * Multi-list overlap books get highest priority.
 */
export const CURATED_BOOKS: CuratedEntry[] = [
  // === Multi-list classics (appear on 3+ lists) ===
  { gutenbergId: 1342, title: 'Pride and Prejudice', lists: ['multi-list-classic', 'guardian-100', '1001-books', 'most-taught', 'librivox-popular'] },
  { gutenbergId: 11, title: 'Alice\'s Adventures in Wonderland', lists: ['multi-list-classic', 'guardian-100', '1001-books', 'most-taught', 'librivox-popular'] },
  { gutenbergId: 1661, title: 'The Adventures of Sherlock Holmes', lists: ['multi-list-classic', 'guardian-100', 'librivox-popular', 'most-taught'] },
  { gutenbergId: 84, title: 'Frankenstein', lists: ['multi-list-classic', 'guardian-100', '1001-books', 'most-taught', 'librivox-popular'] },
  { gutenbergId: 98, title: 'A Tale of Two Cities', lists: ['multi-list-classic', 'guardian-100', '1001-books', 'most-taught'] },
  { gutenbergId: 1260, title: 'Jane Eyre', lists: ['multi-list-classic', 'guardian-100', '1001-books', 'most-taught', 'librivox-popular'] },
  { gutenbergId: 768, title: 'Wuthering Heights', lists: ['multi-list-classic', 'guardian-100', '1001-books', 'most-taught'] },
  { gutenbergId: 174, title: 'The Picture of Dorian Gray', lists: ['multi-list-classic', 'guardian-100', '1001-books', 'most-taught'] },
  { gutenbergId: 1952, title: 'The Yellow Wallpaper', lists: ['multi-list-classic', 'most-taught', '1001-books'] },
  { gutenbergId: 345, title: 'Dracula', lists: ['multi-list-classic', 'guardian-100', '1001-books', 'librivox-popular'] },
  { gutenbergId: 76, title: 'Adventures of Huckleberry Finn', lists: ['multi-list-classic', 'guardian-100', 'most-taught', 'librivox-popular'] },
  { gutenbergId: 1400, title: 'Great Expectations', lists: ['multi-list-classic', 'guardian-100', '1001-books', 'most-taught'] },
  { gutenbergId: 16, title: 'Peter Pan', lists: ['multi-list-classic', 'most-taught', 'librivox-popular'] },
  { gutenbergId: 2701, title: 'Moby Dick', lists: ['multi-list-classic', 'guardian-100', '1001-books', 'most-taught'] },
  { gutenbergId: 36, title: 'The War of the Worlds', lists: ['multi-list-classic', 'guardian-100', '1001-books', 'librivox-popular'] },
  { gutenbergId: 35, title: 'The Time Machine', lists: ['multi-list-classic', 'guardian-100', '1001-books'] },
  { gutenbergId: 1080, title: 'A Modest Proposal', lists: ['multi-list-classic', 'most-taught', '1001-books'] },
  { gutenbergId: 120, title: 'Treasure Island', lists: ['multi-list-classic', 'guardian-100', 'librivox-popular', 'most-taught'] },

  // === Guardian 100 Best Novels ===
  { gutenbergId: 158, title: 'Emma', lists: ['guardian-100', 'penguin-classics'] },
  { gutenbergId: 105, title: 'Persuasion', lists: ['guardian-100', 'penguin-classics'] },
  { gutenbergId: 161, title: 'Sense and Sensibility', lists: ['guardian-100', 'penguin-classics'] },
  { gutenbergId: 946, title: 'The Moonstone', lists: ['guardian-100', 'penguin-classics'] },
  { gutenbergId: 583, title: 'The Woman in White', lists: ['guardian-100', 'penguin-classics'] },
  { gutenbergId: 766, title: 'David Copperfield', lists: ['guardian-100', 'penguin-classics'] },
  { gutenbergId: 730, title: 'Oliver Twist', lists: ['guardian-100', 'penguin-classics'] },
  { gutenbergId: 580, title: 'The Scarlet Letter', lists: ['guardian-100', '1001-books'] },
  { gutenbergId: 514, title: 'Little Women', lists: ['guardian-100', 'most-taught', 'librivox-popular'] },
  { gutenbergId: 2852, title: 'The Hound of the Baskervilles', lists: ['guardian-100', 'librivox-popular'] },
  { gutenbergId: 215, title: 'The Call of the Wild', lists: ['guardian-100', 'most-taught'] },
  { gutenbergId: 5200, title: 'Metamorphosis', lists: ['guardian-100', '1001-books', 'most-taught'] },
  { gutenbergId: 4300, title: 'Ulysses', lists: ['guardian-100', '1001-books'] },
  { gutenbergId: 1232, title: 'The Prince', lists: ['guardian-100', 'most-taught'] },
  { gutenbergId: 244, title: 'A Study in Scarlet', lists: ['guardian-100', 'librivox-popular'] },
  { gutenbergId: 2554, title: 'Crime and Punishment', lists: ['guardian-100', '1001-books', 'penguin-classics'] },
  { gutenbergId: 2600, title: 'War and Peace', lists: ['guardian-100', '1001-books', 'penguin-classics'] },
  { gutenbergId: 2413, title: 'Middlemarch', lists: ['guardian-100', '1001-books', 'penguin-classics'] },
  { gutenbergId: 996, title: 'Don Quixote', lists: ['guardian-100', '1001-books', 'penguin-classics'] },
  { gutenbergId: 1399, title: 'Anna Karenina', lists: ['guardian-100', '1001-books', 'penguin-classics'] },

  // === 1001 Books / Penguin Classics ===
  { gutenbergId: 219, title: 'Heart of Darkness', lists: ['1001-books', 'penguin-classics', 'most-taught'] },
  { gutenbergId: 5740, title: 'A Room with a View', lists: ['1001-books', 'penguin-classics'] },
  { gutenbergId: 2148, title: 'The Invisible Man', lists: ['1001-books', 'penguin-classics'] },
  { gutenbergId: 74, title: 'The Adventures of Tom Sawyer', lists: ['1001-books', 'most-taught', 'librivox-popular'] },
  { gutenbergId: 27827, title: 'The Kama Sutra', lists: ['1001-books', 'penguin-classics'] },
  { gutenbergId: 4517, title: 'Dubliners', lists: ['1001-books', 'most-taught'] },
  { gutenbergId: 4363, title: 'The House of Mirth', lists: ['1001-books', 'penguin-classics'] },
  { gutenbergId: 113, title: 'The Secret Garden', lists: ['1001-books', 'librivox-popular', 'most-taught'] },
  { gutenbergId: 209, title: 'The Turn of the Screw', lists: ['1001-books', 'most-taught'] },
  { gutenbergId: 2500, title: 'Siddhartha', lists: ['1001-books', 'penguin-classics'] },
  { gutenbergId: 2591, title: 'Grimm\'s Fairy Tales', lists: ['penguin-classics', 'librivox-popular'] },
  { gutenbergId: 30254, title: 'The Romance of Lust', lists: ['1001-books'] },

  // === Most-taught in education ===
  { gutenbergId: 1497, title: 'The Republic', lists: ['most-taught', 'penguin-classics'] },
  { gutenbergId: 1250, title: 'Anthem', lists: ['most-taught'] },
  { gutenbergId: 829, title: 'Gulliver\'s Travels', lists: ['most-taught', 'penguin-classics', 'guardian-100'] },
  { gutenbergId: 45, title: 'Anne of Green Gables', lists: ['most-taught', 'librivox-popular'] },
  { gutenbergId: 23, title: 'Narrative of the Life of Frederick Douglass', lists: ['most-taught'] },
  { gutenbergId: 1322, title: 'Leaves of Grass', lists: ['most-taught', 'penguin-classics'] },
  { gutenbergId: 135, title: 'Les Misérables', lists: ['most-taught', '1001-books', 'penguin-classics'] },
  { gutenbergId: 1727, title: 'The Odyssey', lists: ['most-taught', 'penguin-classics'] },
  { gutenbergId: 6130, title: 'The Iliad', lists: ['most-taught', 'penguin-classics'] },
  { gutenbergId: 3207, title: 'Leviathan', lists: ['most-taught', 'penguin-classics'] },
  { gutenbergId: 7370, title: 'Second Treatise of Government', lists: ['most-taught'] },
  { gutenbergId: 4280, title: 'The Art of War', lists: ['most-taught'] },

  // === LibriVox popular (audio-ready, high download count) ===
  { gutenbergId: 1184, title: 'The Count of Monte Cristo', lists: ['librivox-popular', 'penguin-classics'] },
  { gutenbergId: 43, title: 'The Strange Case of Dr. Jekyll and Mr. Hyde', lists: ['librivox-popular', 'most-taught'] },
  { gutenbergId: 46, title: 'A Christmas Carol', lists: ['librivox-popular', 'most-taught'] },
  { gutenbergId: 5230, title: 'The Canterville Ghost', lists: ['librivox-popular'] },
  { gutenbergId: 164, title: 'Twenty Thousand Leagues Under the Sea', lists: ['librivox-popular', 'penguin-classics'] },
  { gutenbergId: 2542, title: 'The Strange Case of Dr Jekyll and Mr Hyde', lists: ['librivox-popular'] },
  { gutenbergId: 236, title: 'The Jungle Book', lists: ['librivox-popular', 'most-taught'] },
  { gutenbergId: 1998, title: 'Thus Spoke Zarathustra', lists: ['librivox-popular', 'penguin-classics'] },
  { gutenbergId: 55, title: 'The Wonderful Wizard of Oz', lists: ['librivox-popular', 'most-taught'] },
  { gutenbergId: 844, title: 'The Importance of Being Earnest', lists: ['librivox-popular', 'most-taught'] },
  { gutenbergId: 1095, title: 'The Communist Manifesto', lists: ['librivox-popular', 'most-taught'] },
  { gutenbergId: 3600, title: 'Essays by Ralph Waldo Emerson', lists: ['librivox-popular', 'most-taught'] },

  // === Science & Philosophy gap fillers ===
  { gutenbergId: 4705, title: 'A Doll\'s House', lists: ['1001-books', 'most-taught'] },
  { gutenbergId: 2680, title: 'Meditations', lists: ['penguin-classics', 'most-taught'] },
  { gutenbergId: 3300, title: 'An Enquiry Concerning Human Understanding', lists: ['penguin-classics'] },
  { gutenbergId: 4067, title: 'Fathers and Sons', lists: ['1001-books', 'penguin-classics'] },
  { gutenbergId: 1228, title: 'On Liberty', lists: ['most-taught', 'penguin-classics'] },
  { gutenbergId: 3076, title: 'On the Origin of Species', lists: ['most-taught', 'penguin-classics'] },
  { gutenbergId: 4280, title: 'The Art of War', lists: ['most-taught'] },
  { gutenbergId: 8700, title: 'The Social Contract', lists: ['most-taught', 'penguin-classics'] },
  { gutenbergId: 5827, title: 'The Problems of Philosophy', lists: ['most-taught'] },
];

/**
 * Build a Map of gutenbergId → total priority bonus from curated lists.
 */
export function buildCuratedPriorityMap(): Map<number, number> {
  const map = new Map<number, number>();
  for (const entry of CURATED_BOOKS) {
    let bonus = 0;
    for (const list of entry.lists) {
      bonus += LIST_BONUS[list] || 0;
    }
    map.set(entry.gutenbergId, bonus);
  }
  return map;
}

/**
 * Get curated IDs that haven't been discovered yet.
 */
export function getCuratedIds(): number[] {
  return CURATED_BOOKS.map(b => b.gutenbergId);
}
