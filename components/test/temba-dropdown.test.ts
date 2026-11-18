import { assert, expect } from '@open-wc/testing';
import { Dropdown } from '../src/display/Dropdown';
import { assertScreenshot, getClip, getComponent } from './utils.test';

const TAG = 'temba-dropdown';

// Helper function to wait for stable rendering
const waitForStableRender = async (dropdown: Dropdown, timeoutMs = 100) => {
  await dropdown.updateComplete;
  // Double wait to ensure any async positioning is complete
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  await dropdown.updateComplete;
};

// Helper function to get expanded clip that includes dropdown content when open
const getDropdownClip = (dropdown: Dropdown) => {
  if (!dropdown.open) {
    // If closed, use regular clipping
    return getClip(dropdown);
  }

  // For open dropdowns, include the positioned dropdown content
  const dropdownDiv = dropdown.shadowRoot.querySelector(
    '.dropdown'
  ) as HTMLDivElement;
  const dropdownBounds = dropdownDiv.getBoundingClientRect();
  const componentBounds = dropdown.getBoundingClientRect();

  // If dropdown content has no meaningful size, fall back to regular clip
  if (dropdownBounds.width < 10 || dropdownBounds.height < 10) {
    return getClip(dropdown);
  }

  // Create a clipping region that includes both the component and the dropdown content
  const minX = Math.min(componentBounds.x, dropdownBounds.x);
  const minY = Math.min(componentBounds.y, dropdownBounds.y);
  const maxX = Math.max(componentBounds.right, dropdownBounds.right);
  const maxY = Math.max(componentBounds.bottom, dropdownBounds.bottom);

  // Clamp to reasonable bounds to avoid excessive screenshot sizes
  const x = Math.max(0, minX - 10);
  const y = Math.max(0, minY - 10);
  const width = Math.min(1000, maxX - minX + 20);
  const height = Math.min(800, maxY - minY + 20);

  return { x, y, width, height };
};

const getDropdown = async (
  attrs: {
    open?: boolean;
    dormant?: boolean;
    arrowSize?: number;
    margin?: number;
    mask?: boolean;
  } = {},
  toggleSlot = '<button slot="toggle">Toggle</button>',
  dropdownSlot = '<div slot="dropdown">Dropdown content</div>'
) => {
  const dropdown = (await getComponent(
    TAG,
    attrs,
    `${toggleSlot}${dropdownSlot}`,
    400,
    300
  )) as Dropdown;
  await dropdown.updateComplete;
  return dropdown;
};

describe(TAG, () => {
  it('can be created', async () => {
    const dropdown = await getDropdown();
    assert.instanceOf(dropdown, Dropdown);
  });

  it('has correct default properties', async () => {
    const dropdown = await getDropdown();

    // Test expected values first
    expect(dropdown.open).to.equal(false);
    expect(dropdown.dormant).to.equal(true);
    expect(dropdown.arrowSize).to.equal(8);
    expect(dropdown.margin).to.equal(10);
    expect(dropdown.mask).to.equal(false);
    // Position calculation happens automatically, so styles won't be empty
    expect(typeof dropdown.dropdownStyle).to.equal('object');
    expect(typeof dropdown.arrowStyle).to.equal('object');

    // Then screenshot
    await assertScreenshot('dropdown/default', getClip(dropdown));
  });

  it('renders with mask when enabled', async () => {
    const dropdown = await getDropdown({ mask: true });
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    // Open the dropdown properly by clicking
    toggle.click();
    await waitForStableRender(dropdown);

    // Test expected values first
    expect(dropdown.mask).to.equal(true);
    expect(dropdown.open).to.equal(true);
    expect(dropdown.dormant).to.equal(false);

    // Then screenshot
    await assertScreenshot('dropdown/with-mask', getDropdownClip(dropdown));
  });

  it('handles toggle click and opens dropdown', async () => {
    const dropdown = await getDropdown();
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    // Verify initial state
    expect(dropdown.open).to.equal(false);
    expect(dropdown.dormant).to.equal(true);

    // Click the toggle
    toggle.click();
    await waitForStableRender(dropdown);

    // Verify dropdown opened
    expect(dropdown.open).to.equal(true);
    expect(dropdown.dormant).to.equal(false);

    // Screenshot the opened state with expanded clip
    await assertScreenshot('dropdown/opened', getDropdownClip(dropdown));
  });

  it('handles custom arrow size', async () => {
    const dropdown = await getDropdown({ arrowSize: 12 });
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    // Open the dropdown properly by clicking
    toggle.click();
    await waitForStableRender(dropdown);

    // Test expected values first
    expect(dropdown.arrowSize).to.equal(12);
    expect(dropdown.open).to.equal(true);
    expect(dropdown.dormant).to.equal(false);

    // Then screenshot
    await assertScreenshot(
      'dropdown/custom-arrow-size',
      getDropdownClip(dropdown)
    );
  });

  it('calculates position correctly', async () => {
    const dropdown = await getDropdown();
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    // Open the dropdown properly by clicking
    toggle.click();
    await dropdown.updateComplete;

    // Trigger position calculation
    dropdown.calculatePosition();
    await waitForStableRender(dropdown);

    // Verify position styles were calculated
    expect(Object.keys(dropdown.dropdownStyle).length).to.be.greaterThan(0);
    expect(Object.keys(dropdown.arrowStyle).length).to.be.greaterThan(0);
    expect(dropdown.open).to.equal(true);
    expect(dropdown.dormant).to.equal(false);

    // Screenshot positioned dropdown
    await assertScreenshot('dropdown/positioned', getDropdownClip(dropdown));
  });

  it('handles blur events to close dropdown', async () => {
    const dropdown = await getDropdown();
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    // Open the dropdown first
    toggle.click();
    await dropdown.updateComplete;
    expect(dropdown.open).to.equal(true);

    // Simulate blur event
    const dropdownDiv = dropdown.shadowRoot.querySelector(
      '.dropdown'
    ) as HTMLDivElement;
    const blurEvent = new FocusEvent('blur', {
      bubbles: true,
      relatedTarget: document.body
    });
    dropdownDiv.dispatchEvent(blurEvent);

    // Check that dropdown is closed after a short delay
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(dropdown.open).to.equal(false);

    // Screenshot closed state
    await assertScreenshot('dropdown/after-blur', getClip(dropdown));
  });

  it('handles blur events when focus moves within dropdown', async () => {
    const dropdown = await getDropdown();
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    // Open the dropdown first
    toggle.click();
    await dropdown.updateComplete;
    expect(dropdown.open).to.equal(true);

    // Create an element within the dropdown
    const dropdownContent = dropdown.querySelector(
      '[slot="dropdown"]'
    ) as HTMLElement;
    const internalButton = document.createElement('button');
    internalButton.textContent = 'Internal';
    dropdownContent.appendChild(internalButton);

    // Simulate blur event where focus moves to internal element
    const dropdownDiv = dropdown.shadowRoot.querySelector(
      '.dropdown'
    ) as HTMLDivElement;
    const blurEvent = new FocusEvent('blur', {
      bubbles: true,
      relatedTarget: internalButton
    });
    dropdownDiv.dispatchEvent(blurEvent);
    await dropdown.updateComplete;

    // Dropdown should remain open since focus moved within it
    expect(dropdown.open).to.equal(true);
  });

  it('prevents opening when already open', async () => {
    const dropdown = await getDropdown();
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    // First, open the dropdown normally
    toggle.click();
    await dropdown.updateComplete;
    expect(dropdown.open).to.equal(true);
    expect(dropdown.dormant).to.equal(false);

    // Now try to click toggle again - should not call openDropdown again
    // since !dropdown.open is false
    const originalOpen = dropdown.open;
    toggle.click();
    await dropdown.updateComplete;

    // Should remain in the same state
    expect(dropdown.open).to.equal(originalOpen);
  });

  it('handles position calculation with right edge collision', async () => {
    // Create dropdown positioned near right edge
    const dropdown = await getDropdown(
      {},
      '<button slot="toggle" style="position: fixed; right: 50px; top: 100px; width: 100px; height: 30px;">Toggle</button>',
      '<div slot="dropdown" style="width: 200px; height: 100px;">Wide content</div>'
    );
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    // Open the dropdown properly by clicking
    toggle.click();
    await waitForStableRender(dropdown);

    // Get actual element bounds to simulate collision
    const dropdownDiv = dropdown.shadowRoot.querySelector(
      '.dropdown'
    ) as HTMLDivElement;
    const originalGetBoundingClientRect = dropdownDiv.getBoundingClientRect;

    // Mock getBoundingClientRect to simulate right collision
    dropdownDiv.getBoundingClientRect = function () {
      return {
        bottom: 200,
        right: window.innerWidth + 100, // Extends beyond window
        top: 100,
        left: window.innerWidth - 50,
        width: 200,
        height: 100,
        x: window.innerWidth - 50,
        y: 100
      } as DOMRect;
    };

    try {
      // Trigger position calculation
      dropdown.calculatePosition();
      await waitForStableRender(dropdown);

      // Verify position was adjusted for right edge
      expect(dropdown.dropdownStyle).to.have.property('left');
    } finally {
      // Restore original method
      dropdownDiv.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it('handles position calculation with bottom edge collision', async () => {
    // Create dropdown positioned near bottom edge
    const dropdown = await getDropdown(
      {},
      '<button slot="toggle" style="position: fixed; left: 100px; bottom: 50px; width: 100px; height: 30px;">Toggle</button>',
      '<div slot="dropdown" style="width: 200px; height: 100px; position: absolute;">Tall content</div>'
    );
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    // Open the dropdown properly by clicking
    toggle.click();
    await waitForStableRender(dropdown);

    // Get actual element bounds to simulate collision
    const dropdownDiv = dropdown.shadowRoot.querySelector(
      '.dropdown'
    ) as HTMLDivElement;
    const originalGetBoundingClientRect = dropdownDiv.getBoundingClientRect;

    // Mock getBoundingClientRect to simulate bottom collision
    dropdownDiv.getBoundingClientRect = function () {
      return {
        bottom: window.innerHeight + 100, // Extends beyond window
        right: 300,
        top: window.innerHeight - 50,
        left: 100,
        width: 200,
        height: 100,
        x: 100,
        y: window.innerHeight - 50
      } as DOMRect;
    };

    try {
      // Trigger position calculation
      dropdown.calculatePosition();
      await waitForStableRender(dropdown);

      // Verify position was adjusted for bottom edge (bumped up), anchored by
      // its bottom so it stays against the toggle if its content shrinks
      expect(dropdown.dropdownStyle['top']).to.equal('auto');
      expect(dropdown.dropdownStyle['bottom']).to.match(/^-?\d+(\.\d+)?px$/);
      expect(dropdown.arrowStyle).to.have.property('transform');
      expect(dropdown.arrowStyle['transform']).to.include('rotate(180deg)');
    } finally {
      // Restore original method
      dropdownDiv.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it('handles arrow positioning when toggle is very narrow', async () => {
    const dropdown = await getDropdown(
      {},
      '<button slot="toggle" style="width: 5px;">•</button>',
      '<div slot="dropdown">Content</div>'
    );
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    // Open the dropdown properly by clicking
    toggle.click();
    await dropdown.updateComplete;

    // Trigger position calculation
    dropdown.calculatePosition();
    await waitForStableRender(dropdown);

    // Verify arrow positioning was adjusted for narrow toggle
    expect(dropdown.dropdownStyle).to.have.property('marginLeft');
    expect(dropdown.dropdownStyle['marginLeft']).to.equal('-10px');
    expect(dropdown.open).to.equal(true);
    expect(dropdown.dormant).to.equal(false);

    // Screenshot with adjusted arrow
    await assertScreenshot('dropdown/narrow-toggle', getDropdownClip(dropdown));
  });

  it('handles position calculation when toggle element is missing', async () => {
    const dropdown = await getDropdown(
      { open: true, dormant: false },
      '', // No toggle element
      '<div slot="dropdown">Content</div>'
    );

    // Trigger position calculation - should handle gracefully
    dropdown.calculatePosition();
    await dropdown.updateComplete;

    // Should not crash and should have basic styles
    expect(typeof dropdown.dropdownStyle).to.equal('object');
    expect(typeof dropdown.arrowStyle).to.equal('object');
  });

  it('handles resetBlurHandler when activeFocus exists', async () => {
    const dropdown = await getDropdown();
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    // Open dropdown to trigger resetBlurHandler for the first time
    toggle.click();
    await dropdown.updateComplete;
    expect(dropdown.open).to.equal(true);

    // Now open it again - this should trigger the activeFocus cleanup branch
    // First we need to close it
    const dropdownDiv = dropdown.shadowRoot.querySelector(
      '.dropdown'
    ) as HTMLDivElement;
    const blurEvent = new FocusEvent('blur', {
      bubbles: true,
      relatedTarget: document.body
    });
    dropdownDiv.dispatchEvent(blurEvent);

    // Wait for close
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(dropdown.open).to.equal(false);
    expect(dropdown.dormant).to.equal(true);

    // Open again - this should trigger the cleanup in resetBlurHandler
    toggle.click();
    await dropdown.updateComplete;
    expect(dropdown.open).to.equal(true);
  });

  it('only hit-tests the popup while open', async () => {
    const dropdown = await getDropdown();
    const toggle = dropdown.querySelector('[slot="toggle"]') as HTMLElement;

    toggle.click();
    await waitForStableRender(dropdown);

    // the open popup is the topmost thing at its own center
    const content = dropdown.querySelector('[slot="dropdown"]') as HTMLElement;
    const bounds = content.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    expect(document.elementFromPoint(x, y)).to.equal(content);

    // after close the popup stays laid out until it goes dormant 250ms
    // later, but it must not swallow clicks aimed at what it was covering
    dropdown.close();
    await dropdown.updateComplete;
    expect(dropdown.open).to.equal(false);
    expect(dropdown.dormant).to.equal(false);
    expect(document.elementFromPoint(x, y)).to.not.equal(content);
  });

  it('renders without mask by default', async () => {
    const dropdown = await getDropdown(); // No mask explicitly set

    // Test expected values first - mask should be false by default
    expect(dropdown.mask).to.equal(false);

    // Look for mask element in shadow DOM - should not exist when mask is false
    const maskElement = dropdown.shadowRoot.querySelector('.mask');
    expect(maskElement).to.be.null;

    // Screenshot default rendering
    await assertScreenshot('dropdown/no-mask', getClip(dropdown));
  });
});
