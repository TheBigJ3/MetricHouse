import { defineConfig } from 'vitepress'
import { writeCrawlerFiles } from './crawlers.js'

/**
 * Set DOCS_BASE when the site is served from a sub path.
 * GitHub Pages at github.com/TheBigJ3/MetricHouse serves from /MetricHouse/.
 * Netlify, Vercel and Cloudflare Pages serve from the root, so leave it unset.
 */
const base = process.env.DOCS_BASE ?? '/'

/**
 * Where the site is served from, without a trailing slash. Used by the sitemap,
 * by robots.txt and by llms.txt, so all three agree about their own URLs.
 */
const SITE = (process.env.DOCS_HOSTNAME ?? 'https://thebigj3.github.io').replace(/\/$/, '')

export default defineConfig({
  base,
  lang: 'en-US',
  title: 'MetricHouse',
  description:
    'A metrics library for TypeScript. It captures counts, values, events, logs and timings, then hands you typed rows to store wherever you like.',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['**/DIAGRAMS.md', '**/README.md'],

  sitemap: { hostname: `${SITE}${base}` },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${base}favicon-32.png` }],
    ['link', { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` }],
    ['meta', { name: 'theme-color', content: '#2357f4' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'MetricHouse' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'A metrics library for TypeScript that captures data now and lets you store it anywhere.',
      },
    ],
    ['meta', { property: 'og:image', content: `${SITE}${base}logo-512.png` }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],

  themeConfig: {
    logo: { light: '/logo.svg', dark: '/logo-dark.svg', alt: 'MetricHouse' },

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

  /**
   * robots.txt, llms.txt and llms-full.txt are generated rather than checked in,
   * because every one of them has to name the host the site is actually served
   * from. One `DOCS_HOSTNAME` decides it for all three and for the sitemap.
   */
  buildEnd(config) {
    return writeCrawlerFiles(config.srcDir, config.outDir, `${SITE}${base}`)
  },
})
