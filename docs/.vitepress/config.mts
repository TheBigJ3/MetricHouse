import { defineConfig } from 'vitepress'

/**
 * Set DOCS_BASE when the site is served from a sub path.
 * GitHub Pages at github.com/TheBigJ3/MetricHouse serves from /MetricHouse/.
 * Netlify, Vercel and Cloudflare Pages serve from the root, so leave it unset.
 */
const base = process.env.DOCS_BASE ?? '/'

export default defineConfig({
  base,
  lang: 'en-US',
  title: 'MetricHouse',
  description:
    'A metrics library for TypeScript. It captures counts, values, events, logs and timings, then hands you typed rows to store wherever you like.',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['**/DIAGRAMS.md', '**/README.md'],

  head: [
    ['meta', { name: 'theme-color', content: '#3b6ef5' }],
    ['meta', { property: 'og:title', content: 'MetricHouse' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'A metrics library for TypeScript that captures data now and lets you store it anywhere.',
      },
    ],
  ],

  themeConfig: {
    outline: { level: [2, 3], label: 'On this page' },

    search: { provider: 'local' },

    nav: [
      { text: 'Guide', link: '/guide/what-is-metrichouse', activeMatch: '/guide/' },
      { text: 'Metric types', link: '/primitives/', activeMatch: '/primitives/' },
      { text: 'Examples', link: '/examples/', activeMatch: '/examples/' },
      { text: 'Reference', link: '/reference/', activeMatch: '/reference/' },
      {
        text: 'v0.1.0',
        items: [
          {
            text: 'Changelog',
            link: 'https://github.com/TheBigJ3/MetricHouse/blob/main/packages/metrichouse/CHANGELOG.md',
          },
          { text: 'npm', link: 'https://www.npmjs.com/package/metrichouse' },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Start here',
        collapsed: false,
        items: [
          { text: 'What MetricHouse is', link: '/guide/what-is-metrichouse' },
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'How it works', link: '/guide/how-it-works' },
        ],
      },
      {
        text: 'Core concepts',
        collapsed: false,
        items: [
          { text: 'Metrics and dimensions', link: '/guide/metrics-and-dimensions' },
          { text: 'Buckets and time', link: '/guide/buckets-and-time' },
          { text: 'The house', link: '/guide/the-house' },
          { text: 'Flushing', link: '/guide/flushing' },
          { text: 'Writing a sink', link: '/guide/writing-a-sink' },
          { text: 'Reading live data', link: '/guide/reading-live-data' },
        ],
      },
      {
        text: 'Metric types',
        collapsed: false,
        items: [
          { text: 'Choosing one', link: '/primitives/' },
          { text: 'counter', link: '/primitives/counter' },
          { text: 'gauge', link: '/primitives/gauge' },
          { text: 'event', link: '/primitives/event' },
          { text: 'log', link: '/primitives/log' },
          { text: 'timer', link: '/primitives/timer' },
        ],
      },
      {
        text: 'Running it',
        collapsed: false,
        items: [
          { text: 'Drivers', link: '/guide/drivers' },
          { text: 'Delivery modes', link: '/guide/delivery' },
          { text: 'Reliability', link: '/guide/reliability' },
          { text: 'Deployment targets', link: '/guide/production' },
        ],
      },
      {
        text: 'Examples',
        collapsed: false,
        items: [
          { text: 'All examples', link: '/examples/' },
          { text: 'Online users', link: '/examples/online-users' },
          { text: 'Dogs walked', link: '/examples/dogs-walked' },
          { text: 'API requests', link: '/examples/api-requests' },
          { text: 'Background jobs', link: '/examples/background-jobs' },
          { text: 'Serverless analytics', link: '/examples/serverless-analytics' },
        ],
      },
      {
        text: 'Reference',
        collapsed: false,
        items: [
          { text: 'API index', link: '/reference/' },
          { text: 'Field types', link: '/reference/field-types' },
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'Driver contract', link: '/reference/driver-contract' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/TheBigJ3/MetricHouse' }],

    editLink: {
      pattern: 'https://github.com/TheBigJ3/MetricHouse/edit/main/docs/:path',
      text: 'Suggest a change to this page',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 MetricHouse contributors',
    },
  },
})
