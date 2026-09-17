// The help site's article page. The sidebar lists the article's top level headings beneath it; as the reader
// scrolls, the heading whose section they're reading is marked current, so the list says where they are as well as
// where they can go. The stylesheet (css/helpsite.css) draws the current mark.
(function () {
  const links = Array.from(
    document.querySelectorAll('.sidebar .headings a[href^="#"]')
  );
  const entries = links
    .map((link) => ({
      item: link.parentElement,
      heading: document.getElementById(decodeURIComponent(link.hash.slice(1)))
    }))
    .filter((entry) => entry.heading);
  if (!entries.length) {
    return;
  }

  // a section is being read once its heading has passed the reading line, a little way down from the top of the
  // window - far enough that a heading scrolled to from the sidebar (which lands at its scroll margin) counts as
  // reached, near enough that the section before it stays current until it's really left
  const READING_LINE = 96;

  let current = null;

  function update() {
    let reached = null;
    for (const entry of entries) {
      if (entry.heading.getBoundingClientRect().top <= READING_LINE) {
        reached = entry;
      } else {
        break;
      }
    }

    // at the foot of a page that scrolls, the last section is the one being read whether or not its heading has
    // reached the line - a short last section can't scroll any further
    const root = document.documentElement;
    const scrolls = root.scrollHeight > window.innerHeight;
    const atFoot = window.innerHeight + window.scrollY >= root.scrollHeight - 1;
    if (scrolls && atFoot) {
      reached = entries[entries.length - 1];
    }

    if (reached === current) {
      return;
    }
    if (current) {
      current.item.classList.remove('current');
      current.item.removeAttribute('aria-current');
    }
    if (reached) {
      reached.item.classList.add('current');
      reached.item.setAttribute('aria-current', 'location');
    }
    current = reached;
  }

  // one update per frame however often the page scrolls or resizes
  let scheduled = false;
  function schedule() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        update();
      });
    }
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('load', schedule); // images arriving move the headings
  update();
})();
