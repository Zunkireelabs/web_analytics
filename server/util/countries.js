// GSC reports country as lowercase ISO 3166-1 alpha-3 codes (e.g. 'ind', 'usa').
// Map the common ones to readable names; unknown codes fall back to uppercase.
const ISO3 = {
  ind: 'India', usa: 'United States', gbr: 'United Kingdom', npl: 'Nepal',
  can: 'Canada', aus: 'Australia', deu: 'Germany', fra: 'France', nld: 'Netherlands',
  pak: 'Pakistan', bgd: 'Bangladesh', lka: 'Sri Lanka', are: 'UAE', sau: 'Saudi Arabia',
  sgp: 'Singapore', mys: 'Malaysia', idn: 'Indonesia', phl: 'Philippines', tha: 'Thailand',
  jpn: 'Japan', chn: 'China', kor: 'South Korea', rus: 'Russia', bra: 'Brazil',
  ita: 'Italy', esp: 'Spain', che: 'Switzerland', swe: 'Sweden', irl: 'Ireland',
  nzl: 'New Zealand', zaf: 'South Africa', nga: 'Nigeria', ken: 'Kenya', egy: 'Egypt',
  tur: 'Turkey', mex: 'Mexico', pol: 'Poland', vnm: 'Vietnam', hkg: 'Hong Kong',
  qat: 'Qatar', kwt: 'Kuwait', omn: 'Oman', bhr: 'Bahrain', bel: 'Belgium',
  aut: 'Austria', dnk: 'Denmark', nor: 'Norway', fin: 'Finland', prt: 'Portugal',
};

export function countryName(code) {
  if (!code) return '(unknown)';
  return ISO3[code.toLowerCase()] || code.toUpperCase();
}
