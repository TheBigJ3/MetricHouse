import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import MhBucketExplorer from './components/MhBucketExplorer.vue'
import MhEventFlow from './components/MhEventFlow.vue'
import MhFoldExplorer from './components/MhFoldExplorer.vue'
import MhLogFilter from './components/MhLogFilter.vue'
import Layout from './Layout.vue'
import './custom.css'

/**
 * `Layout` is the default theme's layout with one slot filled: the home page
 * hero shows the mark and the name as a lockup above the headline.
 *
 * The interactive playgrounds are registered globally so a page can drop one in
 * with a single tag. They are plain Vue, rendered on the server first, so
 * nothing in them may read `window` during setup and nothing may be random.
 */
export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('MhBucketExplorer', MhBucketExplorer)
    app.component('MhFoldExplorer', MhFoldExplorer)
    app.component('MhEventFlow', MhEventFlow)
    app.component('MhLogFilter', MhLogFilter)
  },
} satisfies Theme
