/* TextIt Design System — runtime ramp.
 *
 * Reads --primary (hex) from :root and writes the full accent ramp
 * (--accent + --accent-50..900) onto :root with 400 == primary and
 * the ramp computed outward in both directions via sRGB mixing.
 *
 * Also exposes window.DesignSystem.setPrimary(hex) so the styleguide
 * (or any host page) can re-theme the entire UI at runtime.
 *
 * Mirrors the CSS color-mix(in srgb, ...) ramp definitions, so JS-
 * computed values match the CSS fallbacks when the script is absent.
 */
(function () {
  // Ramp stops as { name: [otherColor, primaryRatio] }.
  // primaryRatio is how much of the primary color (vs the other color).
  var WHITE = [255, 255, 255];
  var BLACK = [0, 0, 0];
  var STOPS = [
    ['--accent-50',  WHITE, 0.06],
    ['--accent-100', WHITE, 0.16],
    ['--accent-200', WHITE, 0.32],
    ['--accent-300', WHITE, 0.60],
    ['--accent-400', null,  1.00],   // 400 == primary
    ['--accent-500', BLACK, 0.90],
    ['--accent-600', BLACK, 0.80],
    ['--accent-700', BLACK, 0.65],
    ['--accent-800', BLACK, 0.50],
    ['--accent-900', BLACK, 0.35],
  ];

  function hexToRgb(hex) {
    hex = hex.trim().replace(/^#/, '');
    if (hex.length === 3) {
      hex = hex.split('').map(function (c) { return c + c; }).join('');
    }
    var n = parseInt(hex, 16);
    if (isNaN(n) || hex.length !== 6) return null;
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }

  function mix(primary, other, t) {
    return [
      Math.round(t * primary[0] + (1 - t) * other[0]),
      Math.round(t * primary[1] + (1 - t) * other[1]),
      Math.round(t * primary[2] + (1 - t) * other[2]),
    ];
  }

  function rgbStr(rgb) {
    return 'rgb(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ')';
  }

  function setPrimary(hex) {
    var primary = hexToRgb(hex);
    if (!primary) return false;
    var root = document.documentElement;
    root.style.setProperty('--primary', '#' + hex.replace(/^#/, ''));
    root.style.setProperty('--primary-rgb', primary.join(', '));
    root.style.setProperty('--accent', rgbStr(primary));
    STOPS.forEach(function (stop) {
      var name = stop[0], other = stop[1], t = stop[2];
      var rgb = other ? mix(primary, other, t) : primary;
      root.style.setProperty(name, rgbStr(rgb));
    });
    return true;
  }

  function init() {
    var primary = getComputedStyle(document.documentElement)
      .getPropertyValue('--primary').trim();
    if (primary) setPrimary(primary);
  }

  window.DesignSystem = window.DesignSystem || {};
  window.DesignSystem.setPrimary = setPrimary;
  window.DesignSystem.hexToRgb  = hexToRgb;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
