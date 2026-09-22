import { assert, expect, fixture, oneEvent, waitUntil } from '@open-wc/testing';
import { SinonStub, stub } from 'sinon';
import { CustomEventType, URN } from '../src/interfaces';
import { TextInput } from '../src/form/TextInput';
import { ContactFieldEditor } from '../src/live/ContactFieldEditor';
import { ContactDetails } from '../src/live/ContactDetails';
import {
  clearMockPosts,
  getComponent,
  loadStore,
  mockGET,
  mockPOST,
  MockSocketProvider,
  waitForWatchedContact
} from './utils.test';
import { resetContactWatches } from '../src/live/ContactWatch';
import { setSocketProvider, SocketProvider } from '../src/live/SocketService';
import { setRealtimeContext } from '../src/live/Realtime';
import { Store } from '../src/store/Store';

const TAG = 'temba-contact-details';
const CONTACT_ID = 'contact-dave-active';
const getContactDetails = async (attrs: any = {}) => {
  const contactDetails = (await getComponent(
    TAG,
    attrs,
    '',
    400
  )) as ContactDetails;
  // wait for our contact to load
  await waitUntil(() => !!contactDetails.data);
  return contactDetails;
};

const SCHEMES = [
  { value: 'tel', name: 'Phone Number' },
  { value: 'telegram', name: 'Telegram Identifier' }
];

const getContactPosts = () =>
  (window.fetch as SinonStub)
    .getCalls()
    .filter(
      (call) =>
        call.args[1]?.method === 'POST' &&
        String(call.args[0]).includes('/api/internal/contacts.json')
    )
    .map((call) => JSON.parse(call.args[1].body));

describe(TAG, () => {
  let mockSocket: MockSocketProvider;
  let previousProvider: SocketProvider;

  beforeEach(() => {
    mockSocket = new MockSocketProvider();
    previousProvider = setSocketProvider(mockSocket);
    clearMockPosts();
    (window.fetch as SinonStub).resetHistory();
    mockGET(
      /\/api\/v2\/contacts.json\?expand_urns=true&urn_order=priority&uuid=contact-dave-active/,
      '/test-assets/contacts/contact-dave-active'
    );
  });

  afterEach(() => {
    resetContactWatches();
    setSocketProvider(previousProvider);
  });

  it('updates live when the name changes', async () => {
    await loadStore();
    const details: ContactDetails = await getContactDetails({
      contact: CONTACT_ID
    });
    expect(details.data.name).to.equal('Dave Matthews');

    await waitForWatchedContact(CONTACT_ID);
    mockSocket.serverPublish(`history:${CONTACT_ID}`, {
      type: 'contact_name_changed',
      name: 'David J. Matthews'
    });

    await waitUntil(() => details.data.name === 'David J. Matthews');
  });

  it('renames groups live from the workspace socket', async () => {
    // a store with a workspace identity subscribes to the org channel
    const store = (await fixture(`
      <temba-store
        org="org-uuid"
        user="user-uuid"
        groups="/test-assets/store/groups.json"
        fields="/test-assets/store/fields.json"
        workspace="/test-assets/store/workspace.json"
      ></temba-store>`)) as Store;
    await store.initialHttpComplete;

    try {
      const details = await getContactDetails({ contact: CONTACT_ID });
      const smart = '12e583b3-46f5-4d9d-85ca-15fb6153c1a0';
      const manual = '3da236a9-9eed-4db3-a18e-cfb58030c249';
      const groupName = (uuid: string) =>
        details.data.groups.find((group) => group.uuid === uuid)?.name;

      expect(groupName(smart)).to.equal('Open Tickets');
      expect(groupName(manual)).to.equal('Completed');

      mockSocket.serverPublish('org:org-uuid', {
        type: 'asset_changed',
        asset: {
          type: 'group',
          uuid: smart,
          name: 'Pending',
          query: 'tickets > 0'
        }
      });
      mockSocket.serverPublish('org:org-uuid', {
        type: 'asset_changed',
        asset: { type: 'group', uuid: manual, name: 'Done', query: null }
      });

      await waitUntil(() => groupName(manual) === 'Done');
      expect(groupName(smart)).to.equal('Pending');
      await details.updateComplete;

      const rows = details.shadowRoot;
      expect(rows.querySelector('.smart-groups').textContent).to.contain(
        'Pending'
      );
      expect(rows.querySelector('.smart-groups').textContent).not.to.contain(
        'Open Tickets'
      );
      expect(
        rows.querySelector('.row:not(.smart-groups)').textContent
      ).to.contain('Done');

      // an unrelated group leaves us alone
      const before = details.data;
      mockSocket.serverPublish('org:org-uuid', {
        type: 'asset_changed',
        asset: { type: 'group', uuid: 'other', name: 'Other', query: null }
      });
      expect(details.data).to.equal(before);
    } finally {
      setRealtimeContext(null);
    }
  });

  it('renders default', async () => {
    await loadStore();
    const contactDetails: ContactDetails = await getContactDetails({
      contact: CONTACT_ID
    });

    assert.instanceOf(contactDetails, ContactDetails);
    expect(contactDetails.shadowRoot.querySelector('temba-select')).to.be.null;
    expect(
      contactDetails.shadowRoot.querySelector(
        'temba-contact-field[name="Name"][disabled]'
      )
    ).to.be.null;
    const wrapper = contactDetails.shadowRoot.querySelector('.wrapper');
    expect(wrapper.firstElementChild.classList.contains('primary-urn')).to.be
      .true;
    const created = contactDetails.shadowRoot.querySelector(
      'temba-contact-field[name="Created"]'
    );
    expect(
      contactDetails.shadowRoot.querySelectorAll(
        '.wrapper > .urn-display temba-contact-field.primary-urn'
      ).length
    ).to.equal(1);
    const primaryUrn = contactDetails.shadowRoot.querySelector(
      '.urn-display temba-contact-field.primary-urn'
    );
    expect(
      getComputedStyle(primaryUrn)
        .getPropertyValue('--contact-field-separator')
        .trim()
    ).to.equal('none');
    expect(getComputedStyle(primaryUrn).marginBottom).to.equal('0px');
    expect(contactDetails.shadowRoot.querySelector('.urn-more-count')).to.be
      .null;
    expect(created.previousElementSibling.classList.contains('additional-urn'))
      .to.be.false;
    const smartGroups =
      contactDetails.shadowRoot.querySelector('.smart-groups.row');
    expect(smartGroups.querySelector('.label').textContent).to.equal(
      'Smart Groups'
    );
    expect(smartGroups.querySelectorAll('temba-label').length).to.equal(1);
    expect(smartGroups.textContent).to.contain('Open Tickets');
    expect(
      contactDetails.shadowRoot.querySelector('.row:not(.smart-groups)')
        .textContent
    ).not.to.contain('Open Tickets');
    // await assertScreenshot('contacts/details', getClip(contactDetails));
  });

  it('renders editable contact attributes', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    contactDetails.schemes = SCHEMES;
    await contactDetails.updateComplete;

    expect(
      contactDetails.shadowRoot.querySelector(
        'temba-contact-field[key="name"]:not([disabled])'
      )
    ).not.to.be.null;
    expect(
      contactDetails.shadowRoot.querySelector(
        'temba-select[endpoint="/api/v2/groups.json?manual_only=1"]'
      )
    ).not.to.be.null;
    expect(
      contactDetails.shadowRoot.querySelectorAll(
        'temba-contact-field[key^="urn-"]'
      ).length
    ).to.equal(0);
    expect(
      contactDetails.shadowRoot.querySelector('temba-sortable-list.urn-list')
    ).not.to.be.null;
    const editIcons = contactDetails.shadowRoot.querySelectorAll(
      '.urn-display > temba-icon.urn-edit-icon'
    );
    expect(editIcons.length).to.equal(1);
    const editIcon = editIcons[0];
    expect(editIcon.getAttribute('aria-label')).to.equal('Edit URNs');
    expect(
      contactDetails.shadowRoot.querySelector('.urn-display > temba-button')
    ).to.be.null;
    expect(
      (contactDetails.shadowRoot.querySelector('temba-dialog') as any).open
    ).to.be.false;
    const wrapper = contactDetails.shadowRoot.querySelector('.wrapper');
    expect(wrapper.firstElementChild.classList.contains('urn-display')).to.be
      .true;
    expect(
      contactDetails.shadowRoot.querySelector(
        '.urn-display temba-contact-field.primary-urn[disabled]'
      )
    ).not.to.be.null;
    expect(
      contactDetails.shadowRoot.querySelectorAll(
        '.wrapper > temba-contact-field[key^="urn-"]'
      ).length
    ).to.equal(0);
    expect(
      contactDetails.shadowRoot.querySelectorAll(
        '.wrapper > .urn-display.additional-urn > temba-contact-field[disabled]'
      ).length
    ).to.equal(0);
    const urnFields = Array.from(
      contactDetails.shadowRoot.querySelectorAll(
        'temba-contact-field.primary-urn'
      )
    ) as ContactFieldEditor[];
    const fieldsWithUnsendablePrefix = urnFields.filter((field) =>
      field.shadowRoot.querySelector('.value > .value-prefix')
    );
    expect(fieldsWithUnsendablePrefix.length).to.equal(0);
    expect(
      contactDetails.shadowRoot.querySelector('.urn-more-count').textContent
    ).to.equal(`+${contactDetails.data.urns.length - 1} more`);
    const smartGroups = contactDetails.shadowRoot.querySelector(
      '.smart-groups.editable-row'
    );
    expect(smartGroups.querySelector('label').textContent).to.equal(
      'Smart Groups'
    );
    expect(smartGroups.querySelectorAll('temba-label').length).to.equal(1);
    expect(smartGroups.textContent).to.contain('Open Tickets');
    const primaryValue = contactDetails.shadowRoot
      .querySelector('temba-contact-field.primary-urn')
      .shadowRoot.querySelector('.value')
      .getBoundingClientRect();
    const editIconBounds = editIcon.getBoundingClientRect();
    const editIconCenterDelta =
      primaryValue.top +
      primaryValue.height / 2 -
      (editIconBounds.top + editIconBounds.height / 2);
    expect(editIconCenterDelta).to.be.closeTo(0, 2);
    const moreBounds = contactDetails.shadowRoot
      .querySelector('.urn-more-count')
      .getBoundingClientRect();
    const moreCenterDelta =
      primaryValue.top +
      primaryValue.height / 2 -
      (moreBounds.top + moreBounds.height / 2);
    expect(moreCenterDelta).to.be.closeTo(0, 2);
    const nameField = contactDetails.shadowRoot.querySelector(
      'temba-contact-field[key="name"]'
    );
    const nameLabel = nameField.shadowRoot
      .querySelector('.field-label')
      .getBoundingClientRect();
    const nameInput = nameField.shadowRoot
      .querySelector('temba-textinput')
      .shadowRoot.querySelector('.input-container')
      .getBoundingClientRect();
    const groupsLabel = contactDetails.shadowRoot
      .querySelector('.editable-row > label')
      .getBoundingClientRect();
    const urnToNameGap = nameLabel.top - primaryValue.bottom;
    const nameToGroupsGap = groupsLabel.top - nameInput.bottom;
    expect(urnToNameGap).to.be.closeTo(nameToGroupsGap, 3);

    contactDetails.setContact({
      ...contactDetails.data,
      groups: contactDetails.data.groups.filter((group) => !group.is_dynamic)
    });
    await contactDetails.updateComplete;
    expect(contactDetails.shadowRoot.querySelector('.smart-groups')).to.be.null;

    const unsendableUrn = contactDetails.data.urns.find(
      (urn) => urn.channel === null
    );
    contactDetails.setContact({
      ...contactDetails.data,
      urns: [unsendableUrn]
    });
    await contactDetails.updateComplete;
    const unsendableSummary = contactDetails.shadowRoot.querySelector(
      '.urn-display.only-unsendable'
    );
    expect(unsendableSummary).not.to.be.null;
    expect(unsendableSummary.getAttribute('aria-label')).to.equal(
      'This contact has no sendable URNs'
    );
    expect(contactDetails.shadowRoot.querySelector('.urn-more-count')).to.be
      .null;
    const unsendableValue = contactDetails.shadowRoot
      .querySelector('temba-contact-field.primary-urn')
      .shadowRoot.querySelector('.value');
    expect(unsendableValue.firstElementChild.classList.contains('value-prefix'))
      .to.be.true;
    expect(
      unsendableValue.firstElementChild
        .querySelector('temba-icon')
        .getAttribute('aria-label')
    ).to.equal('Not sendable: no channel available');
    (
      contactDetails.shadowRoot.querySelector(
        '.urn-display > .urn-edit-icon'
      ) as HTMLElement
    ).click();
    await contactDetails.updateComplete;
    expect(contactDetails.shadowRoot.querySelector('.urn-row .drag-handle')).to
      .be.null;
    expect(
      contactDetails.shadowRoot.querySelector('.wrapper > .additional-urn')
    ).to.be.null;
  });

  it('keeps an edit affordance for contacts without URNs', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    contactDetails.setContact({ ...contactDetails.data, urns: [] });
    await contactDetails.updateComplete;

    const primaryUrn = contactDetails.shadowRoot.querySelector(
      'temba-contact-field.primary-urn'
    ) as ContactFieldEditor;
    expect(primaryUrn).not.to.be.null;
    expect(primaryUrn.value).to.equal('No URNs');
    expect(
      contactDetails.shadowRoot.querySelector('.urn-display > .urn-edit-icon')
    ).not.to.be.null;

    contactDetails.editable = false;
    await contactDetails.updateComplete;
    expect(contactDetails.shadowRoot.querySelector('.urn-display')).to.be.null;
  });

  it('updates status immediately and preserves manual groups', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    mockPOST(/\/api\/internal\/contacts\.json\?uuid=/, {
      ...contactDetails.data,
      status: 'blocked'
    });

    await contactDetails.handleStatusChanged({
      currentTarget: { values: [{ value: 'blocked' }] }
    } as unknown as Event);

    expect(getContactPosts()[0]).to.deep.equal({
      status: 'blocked',
      groups: ['3da236a9-9eed-4db3-a18e-cfb58030c249']
    });
    expect(contactDetails.data.status).to.equal('blocked');
  });

  it('shows the first sendable URN while editing priority order', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    contactDetails.schemes = SCHEMES;
    const unsendable = contactDetails.data.urns.find((urn) => !urn.channel);
    const sendable = contactDetails.data.urns.find((urn) => !!urn.channel);
    const priorityUrns = [
      unsendable,
      sendable,
      ...contactDetails.data.urns.filter(
        (urn) => urn !== unsendable && urn !== sendable
      )
    ];
    contactDetails.setContact({ ...contactDetails.data, urns: priorityUrns });
    await contactDetails.updateComplete;

    expect(
      (
        contactDetails.shadowRoot.querySelector(
          'temba-contact-field.primary-urn'
        ) as ContactFieldEditor
      ).value
    ).to.equal(sendable.display || sendable.path);

    (
      contactDetails.shadowRoot.querySelector('.urn-edit-icon') as HTMLElement
    ).click();
    await contactDetails.updateComplete;
    expect(
      (
        contactDetails.shadowRoot.querySelector(
          'temba-dialog temba-textinput.urn-input[name="urn-0"]'
        ) as any
      ).value
    ).to.equal(unsendable.path);
  });

  it('updates name and language independently', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    mockPOST(/\/api\/internal\/contacts\.json\?uuid=/, {
      ...contactDetails.data,
      name: 'David Matthews',
      language: 'spa'
    });

    const name = contactDetails.shadowRoot.querySelector(
      'temba-contact-field[key="name"]'
    ) as ContactFieldEditor;
    name.value = 'David Matthews';
    await contactDetails.handleTextChanged({
      currentTarget: name
    } as unknown as Event);
    await contactDetails.handleLanguageChanged({
      currentTarget: { values: [{ value: 'spa' }] }
    } as unknown as Event);

    expect(getContactPosts()).to.deep.equal([
      { name: 'David Matthews' },
      { language: 'spa' }
    ]);
    expect(contactDetails.data.name).to.equal('David Matthews');
    expect(contactDetails.data.language).to.equal('spa');
  });

  it('merges contact save responses that arrive out of order', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    const original = contactDetails.data;
    let resolveLanguage: (response: any) => void;
    let resolveStatus: (response: any) => void;
    const postJSON = stub(contactDetails.store, 'postJSON');
    postJSON.onFirstCall().returns(
      new Promise((resolve) => {
        resolveLanguage = resolve;
      })
    );
    postJSON.onSecondCall().returns(
      new Promise((resolve) => {
        resolveStatus = resolve;
      })
    );

    try {
      const languageSave = contactDetails.handleLanguageChanged({
        currentTarget: { values: [{ value: 'spa' }] }
      } as unknown as Event);
      const statusSave = contactDetails.handleStatusChanged({
        currentTarget: { values: [{ value: 'blocked' }] }
      } as unknown as Event);

      resolveStatus({
        status: 200,
        json: { ...original, status: 'blocked' },
        headers: new Headers()
      });
      await statusSave;
      expect(contactDetails.data.status).to.equal('blocked');

      resolveLanguage({
        status: 200,
        json: { ...original, language: 'spa' },
        headers: new Headers()
      });
      await languageSave;
      expect(contactDetails.data.status).to.equal('blocked');
      expect(contactDetails.data.language).to.equal('spa');
    } finally {
      postJSON.restore();
    }
  });

  it('preserves fields omitted from contact save responses', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    const groups = contactDetails.data.groups;
    const postJSON = stub(contactDetails.store, 'postJSON').resolves({
      status: 200,
      json: { status: 'blocked' },
      headers: new Headers()
    });

    try {
      await contactDetails.handleStatusChanged({
        currentTarget: { values: [{ value: 'blocked' }] }
      } as unknown as Event);

      expect(contactDetails.data.status).to.equal('blocked');
      expect(contactDetails.data.groups).to.deep.equal(groups);
    } finally {
      postJSON.restore();
    }
  });

  it('waits for a group save before changing active status', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    const original = contactDetails.data;
    const selected = [
      {
        uuid: '512e36c1-9101-4ca2-aceb-e638c520bf0c',
        name: 'Reminders'
      }
    ];
    let resolveGroups: (response: any) => void;
    let resolveStatus: (response: any) => void;
    const postJSON = stub(contactDetails.store, 'postJSON');
    postJSON.onFirstCall().returns(
      new Promise((resolve) => {
        resolveGroups = resolve;
      })
    );
    postJSON.onSecondCall().returns(
      new Promise((resolve) => {
        resolveStatus = resolve;
      })
    );

    try {
      const groupsSave = contactDetails.handleGroupsChanged({
        currentTarget: { values: selected }
      } as unknown as Event);
      const statusSave = contactDetails.handleStatusChanged({
        currentTarget: { values: [{ value: 'blocked' }] }
      } as unknown as Event);
      expect(postJSON.callCount).to.equal(1);

      resolveGroups({
        status: 200,
        json: { ...original, groups: selected },
        headers: new Headers()
      });
      await groupsSave;
      await waitUntil(() => postJSON.callCount === 2);
      expect(postJSON.secondCall.args[1]).to.deep.equal({
        status: 'blocked',
        groups: ['512e36c1-9101-4ca2-aceb-e638c520bf0c']
      });

      resolveStatus({
        status: 200,
        json: { ...original, status: 'blocked', groups: selected },
        headers: new Headers()
      });
      await statusSave;
      expect(contactDetails.data.status).to.equal('blocked');
      expect(contactDetails.data.groups[0].name).to.equal('Reminders');
    } finally {
      postJSON.restore();
    }
  });

  it('ignores a save response after switching contacts', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    const original = contactDetails.data;
    const otherContact = {
      ...original,
      uuid: 'other-contact',
      name: 'Other Contact'
    };
    mockGET(
      /\/api\/v2\/contacts\.json\?expand_urns=true&urn_order=priority&uuid=other-contact/,
      { next: null, previous: null, results: [otherContact] }
    );
    let resolveSave: (response: any) => void;
    const postJSON = stub(contactDetails.store, 'postJSON').returns(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );

    try {
      const save = contactDetails.handleLanguageChanged({
        currentTarget: { values: [{ value: 'spa' }] }
      } as unknown as Event);
      contactDetails.contact = 'other-contact';
      await contactDetails.updateComplete;
      await waitUntil(() => contactDetails.data?.uuid === 'other-contact');

      resolveSave({
        status: 200,
        json: { ...original, name: 'Stale Contact', language: 'spa' },
        headers: new Headers()
      });
      await save;

      expect(contactDetails.data.uuid).to.equal('other-contact');
      expect(contactDetails.data.name).to.equal('Other Contact');
    } finally {
      postJSON.restore();
    }
  });

  it('clears contact state and rejects edits while a contact loads', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    contactDetails.schemes = SCHEMES;
    contactDetails.showUrnDialog();
    contactDetails.handleNewUrnChanged({
      currentTarget: { value: '+12065550123' }
    } as unknown as Event);
    contactDetails.handleAddUrn();
    await contactDetails.updateComplete;
    expect(
      (contactDetails.shadowRoot.querySelector('temba-dialog') as any).open
    ).to.be.true;

    const makeRequest = stub(contactDetails.store, 'makeRequest');
    const postJSON = stub(contactDetails.store, 'postJSON');
    try {
      contactDetails.contact = 'other-contact';
      await contactDetails.handleLanguageChanged({
        currentTarget: { values: [{ value: 'spa' }] }
      } as unknown as Event);
      await contactDetails.updateComplete;

      expect(postJSON.called).to.be.false;
      expect(makeRequest.calledWith(contactDetails.url)).to.be.true;
      expect(contactDetails.data).to.be.null;
      expect(contactDetails.shadowRoot.querySelector('temba-dialog')).to.be
        .null;
    } finally {
      makeRequest.restore();
      postJSON.restore();
    }
  });

  it('loads a saved contact from cache when remounted', async () => {
    await loadStore();
    const attrs = {
      contact: CONTACT_ID,
      editable: true
    };
    const contactDetails = await getContactDetails(attrs);
    mockPOST(/\/api\/internal\/contacts\.json\?uuid=/, {
      ...contactDetails.data,
      status: 'blocked'
    });

    await contactDetails.handleStatusChanged({
      currentTarget: { values: [{ value: 'blocked' }] }
    } as unknown as Event);
    contactDetails.remove();

    const remounted = await getContactDetails(attrs);
    expect(remounted.data.status).to.equal('blocked');
  });

  it('reorders URNs with the keyboard', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    contactDetails.schemes = SCHEMES;
    contactDetails.showUrnDialog();
    await contactDetails.updateComplete;
    const firstPath = contactDetails.data.urns[0].path;
    const secondPath = contactDetails.data.urns[1].path;
    const firstHandle = contactDetails.shadowRoot.querySelector(
      '#urn-0 .drag-handle'
    ) as HTMLElement;
    expect(firstHandle.getAttribute('role')).to.equal('button');
    expect(firstHandle.getAttribute('tabindex')).to.equal('0');
    expect(firstHandle.getAttribute('aria-label')).to.contain(
      'Use the up and down arrow keys'
    );

    firstHandle.focus();
    firstHandle.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true
      })
    );
    await contactDetails.updateComplete;

    const inputs = contactDetails.shadowRoot.querySelectorAll(
      'temba-textinput.urn-input'
    ) as NodeListOf<TextInput>;
    expect(inputs[0].value).to.equal(secondPath);
    expect(inputs[1].value).to.equal(firstPath);
    expect(contactDetails.shadowRoot.activeElement).to.equal(
      contactDetails.shadowRoot.querySelector('#urn-1 .drag-handle')
    );
  });

  it('drafts URN changes and applies them together on Save', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    contactDetails.schemes = SCHEMES;
    await contactDetails.updateComplete;
    mockPOST(/\/api\/internal\/contacts\.json\?uuid=/, {
      ...contactDetails.data,
      urns: contactDetails.data.urns
    });

    (
      contactDetails.shadowRoot.querySelector(
        '.urn-display > temba-icon.urn-edit-icon'
      ) as HTMLElement
    ).click();
    await contactDetails.updateComplete;
    const dialog = contactDetails.shadowRoot.querySelector(
      'temba-dialog'
    ) as any;
    expect(dialog.open).to.be.true;
    expect(dialog.querySelector('temba-sortable-list')).not.to.be.null;
    expect(dialog.querySelector('.add-urn-fields')).not.to.be.null;
    expect(
      dialog.querySelectorAll('temba-textinput.urn-input').length
    ).to.equal(contactDetails.data.urns.length);
    expect(dialog.querySelectorAll('.urn-delete-icon').length).to.equal(
      contactDetails.data.urns.length
    );
    expect(dialog.querySelectorAll('.urn-row.sortable').length).to.equal(
      contactDetails.data.urns.length
    );
    expect(dialog.querySelectorAll('.urn-row .drag-handle').length).to.equal(
      contactDetails.data.urns.length
    );
    expect(
      dialog.querySelectorAll('.urn-sendability.unsendable').length
    ).to.equal(
      contactDetails.data.urns.filter((urn) => urn.channel === null).length
    );
    expect(
      dialog
        .querySelector('.urn-sendability.unsendable temba-icon')
        .getAttribute('aria-label')
    ).to.equal('Not sendable: no channel available');
    await dialog.updateComplete;

    const firstUrn = dialog.querySelector(
      'temba-textinput.urn-input[name="urn-0"]'
    ) as any;
    const list = dialog.querySelector('temba-sortable-list');
    expect(list.gap).to.equal('12px');
    const listBounds = list.getBoundingClientRect();
    const urnBounds = firstUrn.getBoundingClientRect();
    expect(Math.abs(urnBounds.right - listBounds.right)).to.be.lessThan(1);
    const addFields = dialog.querySelector('.add-urn-fields');
    const typeBounds = addFields.firstElementChild.getBoundingClientRect();
    expect(Math.abs(typeBounds.left - urnBounds.left)).to.be.lessThan(1);
    const dialogBounds = dialog
      .querySelector('.urn-dialog')
      .getBoundingClientRect();
    const dialogPadding = getComputedStyle(dialog.querySelector('.urn-dialog'));
    expect(dialogPadding.paddingTop).to.equal('24px');
    expect(dialogPadding.paddingTop).to.equal(dialogPadding.paddingLeft);
    const handleBounds = dialog
      .querySelector('.drag-handle')
      .getBoundingClientRect();
    const firstInputBounds = firstUrn.shadowRoot
      .querySelector('.input-container')
      .getBoundingClientRect();
    const handleCenterDelta =
      firstInputBounds.top +
      firstInputBounds.height / 2 -
      (handleBounds.top + handleBounds.height / 2);
    expect(handleCenterDelta).to.be.closeTo(0, 1);
    expect(firstUrn.hasAttribute('clearable')).to.be.false;
    expect(firstUrn.shadowRoot.querySelector('.clear-icon')).to.be.null;
    expect(
      Math.abs(
        handleBounds.left -
          dialogBounds.left -
          (dialogBounds.right - urnBounds.right)
      )
    ).to.be.lessThan(3);
    const addressInput = addFields.querySelector('temba-textinput');
    const addressBounds = addressInput.shadowRoot
      .querySelector('.input-container')
      .getBoundingClientRect();
    const addButton = addFields.querySelector('temba-button');
    const addButtonBounds = addButton.shadowRoot
      .querySelector('.button-container')
      .getBoundingClientRect();
    expect(
      Math.abs(addressBounds.height - addButtonBounds.height)
    ).to.be.lessThan(1);
    const addButtonCenterDelta =
      addressBounds.top +
      addressBounds.height / 2 -
      (addButtonBounds.top + addButtonBounds.height / 2);
    expect(addButtonCenterDelta).to.be.closeTo(0, 1);
    const ghost = dialog
      .querySelector('.urn-row')
      .cloneNode(true) as HTMLElement;
    list.prepareGhost(ghost);
    expect(ghost.style.getPropertyValue('display')).to.equal('grid');
    expect(ghost.style.getPropertyPriority('display')).to.equal('important');
    expect(ghost.style.getPropertyValue('grid-template-columns')).to.equal(
      '18px minmax(0px, 1fr)'
    );
    expect(
      (ghost.querySelector('.drag-slot') as HTMLElement).style.getPropertyValue(
        'display'
      )
    ).to.equal('flex');
    expect(
      (ghost.querySelector('.drag-slot') as HTMLElement).style.getPropertyValue(
        'align-self'
      )
    ).to.equal('end');

    const expectedUrns: URN[] = contactDetails.data.urns.map((urn) => ({
      ...urn
    }));
    expectedUrns[0].path = 'new-handle';
    firstUrn.value = 'new-handle';
    contactDetails.handleDraftUrnChanged(
      {
        currentTarget: firstUrn
      } as unknown as Event,
      0
    );
    await contactDetails.updateComplete;

    contactDetails.handleNewUrnChanged({
      currentTarget: { value: '+12065550123' }
    } as unknown as Event);
    contactDetails.handleAddUrn();
    expectedUrns.push({
      scheme: 'tel',
      path: '+12065550123'
    });
    await contactDetails.updateComplete;
    const addedRow = dialog.querySelector('.urn-row:last-child');
    expect(addedRow.classList.contains('sortable')).to.be.true;
    expect(addedRow.querySelector('.drag-handle')).not.to.be.null;
    expect(addedRow.querySelector('.urn-sendability')).to.be.null;
    expect(dialog.querySelectorAll('.urn-delete-icon').length).to.equal(
      expectedUrns.length
    );

    (dialog.querySelector('#urn-1 .urn-delete-icon') as HTMLElement).click();
    expectedUrns.splice(1, 1);
    await contactDetails.updateComplete;
    expect(dialog.querySelectorAll('.urn-row').length).to.equal(
      expectedUrns.length
    );
    for (const urnInput of dialog.querySelectorAll(
      'temba-textinput.urn-input'
    )) {
      expect(urnInput.hasAttribute('clearable')).to.be.false;
      expect(urnInput.shadowRoot.querySelector('.clear-icon')).to.be.null;
    }

    expect(getContactPosts()).to.deep.equal([]);
    expect(contactDetails.data.urns[0].path).to.equal('24028613');

    const moved = expectedUrns.splice(expectedUrns.length - 1, 1)[0];
    expectedUrns.unshift(moved);
    let orderEventEscaped = false;
    contactDetails.addEventListener(CustomEventType.OrderChanged, () => {
      orderEventEscaped = true;
    });
    list.dispatchEvent(
      new CustomEvent(CustomEventType.OrderChanged, {
        detail: { swap: [expectedUrns.length - 1, 0] },
        bubbles: true,
        composed: true
      })
    );
    await contactDetails.updateComplete;
    expect(orderEventEscaped).to.be.false;
    expect(getContactPosts()).to.deep.equal([]);
    expect(
      (dialog.querySelector('temba-textinput.urn-input[name="urn-0"]') as any)
        .value
    ).to.equal('+12065550123');

    let dialogButtonEscaped = false;
    contactDetails.addEventListener(CustomEventType.ButtonClicked, () => {
      dialogButtonEscaped = true;
    });
    dialog.getPrimaryButton().click();
    await waitUntil(() => getContactPosts().length === 1 && !dialog.open);
    expect(dialog.open).to.be.false;
    expect(dialogButtonEscaped).to.be.false;
    expect(getContactPosts()).to.deep.equal([
      {
        urns: expectedUrns
          .filter((urn) => urn.path)
          .map((urn) => `${urn.scheme}:${urn.path}`)
      }
    ]);
  });

  it('discards URN drafts on Cancel', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    contactDetails.schemes = SCHEMES;
    await contactDetails.updateComplete;
    (
      contactDetails.shadowRoot.querySelector('.urn-edit-icon') as HTMLElement
    ).click();
    await contactDetails.updateComplete;

    contactDetails.handleNewUrnChanged({
      currentTarget: { value: '+12065550123' }
    } as unknown as Event);
    contactDetails.handleAddUrn();
    (contactDetails.shadowRoot.querySelector('temba-dialog') as any)
      .getCancelButton()
      .click();
    await contactDetails.updateComplete;

    expect(getContactPosts()).to.deep.equal([]);
    (
      contactDetails.shadowRoot.querySelector('.urn-edit-icon') as HTMLElement
    ).click();
    await contactDetails.updateComplete;
    expect(
      contactDetails.shadowRoot.querySelectorAll(
        'temba-dialog temba-textinput.urn-input'
      ).length
    ).to.equal(contactDetails.data.urns.length);
  });

  it('re-emits name searches from the details component', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    const name = contactDetails.shadowRoot.querySelector(
      'temba-contact-field[key="name"]'
    ) as ContactFieldEditor;
    const searched = oneEvent(
      contactDetails,
      CustomEventType.ButtonClicked,
      false
    );

    name.handleIconClick({
      target: { getAttribute: () => 'search' },
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    } as unknown as MouseEvent);

    const event = await searched;
    expect(event.target).to.equal(contactDetails);
    expect(event.detail).to.deep.equal({ key: 'name', value: 'Dave Matthews' });
  });

  it('updates selected manual groups', async () => {
    await loadStore();
    const contactDetails = await getContactDetails({
      contact: CONTACT_ID,
      editable: true
    });
    const selected = [
      {
        uuid: '512e36c1-9101-4ca2-aceb-e638c520bf0c',
        name: 'Reminders'
      }
    ];
    mockPOST(/\/api\/internal\/contacts\.json\?uuid=/, {
      ...contactDetails.data,
      groups: selected
    });

    await contactDetails.handleGroupsChanged({
      currentTarget: { values: selected }
    } as unknown as Event);

    expect(getContactPosts()[0]).to.deep.equal({
      groups: ['512e36c1-9101-4ca2-aceb-e638c520bf0c']
    });
    expect(contactDetails.data.groups[0].name).to.equal('Reminders');
  });
});
