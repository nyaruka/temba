# temba-components

[![Coverage](https://nyaruka.github.io/temba-components/coverage-badge.svg)](https://nyaruka.github.io/temba-components/)

Coverage reports are automatically generated and deployed to [GitHub Pages](https://nyaruka.github.io/temba-components/) from the `coverage` branch after each merge to main.

temba-components is a suite of ui widgets used by various RapidPro projects.

Some of the components:

- `<temba-select/>` Advanced select widget with support for remote fetching and filtering. Also supports multi selection with the ability to enter expressions.

- `<temba-completion/>` Completion widget for completing RP-style expressions
- `<temba-textinput/>` - Standard text field with baked in support for date picking
- `<temba-charcount/>` - SMS segment counter attachable to elements for monitoring
- `<temba-store/>` - In page cache for RP core data types
- `<temba-options/>` - Generic option list with configurable rendering, remote list paging, and keyboard support. Used by temba-select, temba-completion, and temba-list
- `<temba-list/>` - Block rendered option list
- `<temba-dialog/>` - Basic modal
- `<temba-modax/>` - Fancier modal that fetches and submits html rendered forms and is triggered by a slot element
- .. and many more

## Install

We use [bun](https://bun.com), so you'll want to install with that if you care about our lock file.

```bash
% bun install
```

## Demo

The interactive demo is served by the Django dev server (`DEBUG` only) at `/demo/`. It uses the
live dev build of the components (`bun run watch` keeping `dev-dist/` fresh, along with the
standalone webchat bundle in `dist/temba-webchat.js` — the dev stack runs this for you) and hits
the real temba endpoints, so demos show whatever data the logged-in user has.

## Testing

All tests live under [/test](test). When running tests, some tests capture screenshots for pixel
comparision under [/screenshots](screenshots/truth). Running tests requires that you have Chromium
installed.

```bash
% bun run test
```

## Usage

Simply include the built file as a module and you should be off to the races!

```html
<html>
  <head>
    <script type="module">
      import '/static/components-dev/temba-modules.js';
    </script>
  </head>
  <body>
    <temba-select name="color">
      <temba-option name="Red" value="r"></temba-option>
      <temba-option name="Green" value="g"></temba-option>
      <temba-option name="Blue" value="b"></temba-option>
    </temba-select>
  </body>
</html>
```
