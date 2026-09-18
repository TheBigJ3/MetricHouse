<script setup lang="ts">
/**
 * The name on the home page: the mark, then the word, at wordmark size.
 *
 * The hero used to set `name` in the page frontmatter, which the default theme
 * draws as a huge tinted word above the headline. Two large lines competed,
 * and the tint did the work the logo should do. So the name is shown here the
 * way a logo is, and the large type is left to the sentence that says what the
 * library does.
 *
 * The mark is inline rather than the file in `public/`, for two reasons. It
 * takes its colour from CSS, so it needs no second copy for the dark theme,
 * and it costs no request. `public/logo.svg` is still the same geometry.
 */
</script>

<template>
  <div class="mh-lockup">
    <svg class="mh-lockup__mark" viewBox="234 210 786 786" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        <path d="M333 882 L333 514 L626 309 L921 514 L921 882" stroke-width="53" />
        <path d="M443 759 L561 640 L676 748 L805 610" stroke-width="42" />
      </g>
      <g fill="currentColor">
        <circle cx="627" cy="324" r="58" />
        <circle cx="333" cy="514" r="58" />
        <circle cx="921" cy="514" r="58" />
        <circle cx="333" cy="882" r="58" />
        <circle cx="921" cy="882" r="58" />
        <circle cx="443" cy="759" r="43" />
        <circle cx="561" cy="640" r="43" />
        <circle cx="676" cy="748" r="43" />
        <circle cx="805" cy="610" r="43" />
      </g>
    </svg>
    <span class="mh-lockup__name">MetricHouse</span>
  </div>
</template>
