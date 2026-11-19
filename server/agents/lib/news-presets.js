// Starting settings for news-based posts, per kind of client. A preset is only a starting point: it is written to a project's
// site_news_config row by scripts/set-news-config.js, and the row is what the agent reads. Official pages listed here were
// opened on 2026-11-19. Sites that block automated readers (travel.state.gov and Home Affairs answered 403) or that only show their text after
// JavaScript runs (DAAD, make-it-in-germany.com) are left out on purpose: a lead that cannot be confirmed is dropped, so listing them would only produce dropped leads.
export const NEWS_PRESETS = {
  admizz: {
    intervalDays: 7,
    leadFeeds: [
      { id: 'icef-monitor', name: 'ICEF Monitor', url: 'https://monitor.icef.com/feed/' },
      { id: 'the-pie', name: 'The PIE News', url: 'https://thepienews.com/feed/' },
    ],
    officialSources: [
      { country: 'UK', name: 'GOV.UK Student visa', pages: ['https://www.gov.uk/student-visa/money', 'https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-student', 'https://www.gov.uk/government/organisations/uk-visas-and-immigration'] },
      { country: 'Canada', name: 'IRCC study permits', pages: ['https://www.canada.ca/en/immigration-refugees-citizenship/news/notices.html', 'https://www.canada.ca/en/immigration-refugees-citizenship/services/study-canada/study-permit/get-documents.html', 'https://www.canada.ca/en/immigration-refugees-citizenship/services/study-canada/study-permit/prepare.html'] },
      { country: 'US', name: 'ICE SEVP', pages: ['https://www.ice.gov/sevis'] },
    ],
    styleRules: [
      'Write in American English (counseling, program, enrollment, center).',
      'Say "Nepali", never "Nepalese". Dates month first (November 30, 2026). Money with commas (£6,000). Write "US" in sentences.',
      'Keep official names exactly as the official page writes them (Confirmation of Enrolment, Dependants, sponsor licence).',
      'Put the year and the Nepal angle in the title where true. Audience: students from Nepal and their families.',
      'Link to a related post and to a hub page such as /top-education-consultancy-in-nepal or /study-in-<country>-from-nepal.',
      'Never make claims about named competitors.',
    ].join('\n'),
  },
};
