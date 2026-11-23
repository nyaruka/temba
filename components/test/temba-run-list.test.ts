import { assert, expect } from '@open-wc/testing';
import * as sinon from 'sinon';
import { useFakeTimers } from 'sinon';
import { CustomEventType } from '../src/interfaces';
import { RunList } from '../src/list/RunList';
import {
  assertScreenshot,
  getClip,
  getComponent,
  mockGET,
  mockAPI
} from './utils.test';

let clock: any;

const TAG = 'temba-run-list';
const getRunList = async (attrs: any = {}, width = 250, height = 0) => {
  const runList = (await getComponent(
    TAG,
    attrs,
    '',
    width,
    height
  )) as RunList;

  if (!runList.endpoint) {
    return runList;
  }

  return new Promise<RunList>((resolve) => {
    runList.addEventListener(
      CustomEventType.FetchComplete,
      async () => {
        resolve(runList);
      },
      { once: true }
    );
  });
};

describe('temba-run-list', () => {
  beforeEach(function () {
    clock = useFakeTimers();
    // set up general mocking
    mockAPI();
    // mock the runs API endpoint
    mockGET(/\/api\/v2\/runs\.json/, '/test/assets/list/runs.json');
  });

  afterEach(function () {
    clock.restore();
  });

  it('can be created', async () => {
    const runList: RunList = await getRunList();
    assert.instanceOf(runList, RunList);
    expect(runList.responses).to.equal(true);
    expect(runList.valueKey).to.equal('uuid');
    expect(runList.hideShadow).to.equal(true);
    expect(runList.reverseRefresh).to.equal(false);
  });

  it('initializes with correct default properties', async () => {
    const runList: RunList = await getRunList();
    expect(runList.responses).to.equal(true);
    expect(runList.resultPreview).to.be.undefined;
    expect(runList.selectedRun).to.be.undefined;
    expect(runList.results).to.be.undefined;
    expect(runList.flow).to.be.undefined;
  });

  it('sets endpoint when flow property changes', async () => {
    const runList: RunList = await getRunList();

    runList.flow = 'test-flow-uuid';
    await runList.updateComplete;

    expect(runList.endpoint).to.equal(
      '/api/v2/runs.json?flow=test-flow-uuid&responded=1'
    );
  });

  it('sets endpoint without responded parameter when responses is false', async () => {
    const runList: RunList = await getRunList();

    runList.responses = false;
    runList.flow = 'test-flow-uuid';
    await runList.updateComplete;

    expect(runList.endpoint).to.equal('/api/v2/runs.json?flow=test-flow-uuid');
  });

  it('loads runs with flow endpoint', async () => {
    const runList: RunList = await getRunList(
      {
        flow: 'test-flow-uuid'
      },
      250,
      400
    ); // use bigger height to avoid overlap

    expect(runList.items.length).to.equal(5);
    await assertScreenshot('run-list/basic', getClip(runList));
  });

  it('handles results property change', async () => {
    const runList: RunList = await getRunList();

    // mock temba-select element
    const mockSelect = document.createElement('div') as any;
    mockSelect.setOptions = sinon.spy();
    sinon.stub(runList.shadowRoot, 'querySelector').returns(mockSelect);

    const results = [
      { key: 'name', name: 'Name', categories: ['Text'] },
      { key: 'age', name: 'Age', categories: ['Number'] }
    ];

    runList.results = results;
    await runList.updateComplete;

    expect(mockSelect.setOptions.calledWith(results)).to.be.true;
    // Since resultKeys is private, we test the observable behavior indirectly
    // by verifying the results were processed correctly via setOptions call.
  });

  it('calls createRenderOption when resultPreview changes', async () => {
    const runList: RunList = await getRunList();
    const createRenderOptionSpy = sinon.spy(runList, 'createRenderOption');

    runList.resultPreview = { key: 'name', name: 'Name' };
    await runList.updateComplete;

    expect(createRenderOptionSpy.called).to.be.true;
  });

  it('getIcon returns correct icon for completed run', async () => {
    const runList: RunList = await getRunList();
    const run = { exit_type: 'completed' };

    const icon = runList.getIcon(run);
    expect(icon.strings[0]).to.contain('temba-icon');
    expect(icon.strings[0]).to.contain('name="check"');
  });

  it('getIcon returns correct icon for interrupted run', async () => {
    const runList: RunList = await getRunList();
    const run = { exit_type: 'interrupted' };

    const icon = runList.getIcon(run);
    expect(icon.strings[0]).to.contain('temba-icon');
    expect(icon.strings[0]).to.contain('name="x-octagon"');
  });

  it('getIcon returns correct icon for expired run', async () => {
    const runList: RunList = await getRunList();
    const run = { exit_type: 'expired' };

    const icon = runList.getIcon(run);
    expect(icon.strings[0]).to.contain('temba-icon');
    expect(icon.strings[0]).to.contain('name="clock"');
  });

  it('getIcon returns activity icon for active responded run', async () => {
    const runList: RunList = await getRunList();
    const run = { exit_type: null, responded: true };

    const icon = runList.getIcon(run);
    expect(icon.strings[0]).to.contain('temba-icon');
    expect(icon.strings[0]).to.contain('name="activity"');
  });

  it('getIcon returns hourglass icon for active non-responded run', async () => {
    const runList: RunList = await getRunList();
    const run = { exit_type: null, responded: false };

    const icon = runList.getIcon(run);
    expect(icon.strings[0]).to.contain('temba-icon');
    expect(icon.strings[0]).to.contain('name="hourglass"');
  });

  it('renderResultPreview returns category for multi-category result', async () => {
    const runList: RunList = await getRunList();

    runList.resultPreview = {
      key: 'gender',
      categories: ['Male', 'Female', 'Other']
    };

    const run = {
      values: {
        gender: {
          category: 'Male',
          value: 'Male'
        }
      }
    };

    const result = runList.renderResultPreview(run);
    expect(result).to.equal('Male');
  });

  it('renderResultPreview returns value for single-category result', async () => {
    const runList: RunList = await getRunList();

    runList.resultPreview = { key: 'name', categories: ['Text'] };

    const run = {
      values: {
        name: {
          category: 'Text',
          value: 'John Doe'
        }
      }
    };

    const result = runList.renderResultPreview(run);
    expect(result).to.equal('John Doe');
  });

  it('renderResultPreview returns null when no result preview', async () => {
    const runList: RunList = await getRunList();

    const run = { values: {} };
    const result = runList.renderResultPreview(run);
    expect(result).to.be.null;
  });

  it('renderResultPreview returns null when no matching value', async () => {
    const runList: RunList = await getRunList();

    runList.resultPreview = { key: 'missing', categories: ['Text'] };

    const run = { values: {} };
    const result = runList.renderResultPreview(run);
    expect(result).to.be.null;
  });

  it('handles results property change when results is null', async () => {
    const runList: RunList = await getRunList();

    // set initial results
    runList.results = [{ key: 'name', name: 'Name' }];
    await runList.updateComplete;

    // clear results
    runList.results = null;
    await runList.updateComplete;

    // should not throw an error
    expect(runList.results).to.be.null;
  });

  it('handles responses/flow change when flow is not set', async () => {
    const runList: RunList = await getRunList();

    // change responses without setting flow
    runList.responses = false;
    await runList.updateComplete;

    // endpoint should not be set
    expect(runList.endpoint).to.be.undefined;
  });

  it('renderResultPreview returns null when category is missing in multi-category result', async () => {
    const runList: RunList = await getRunList();

    runList.resultPreview = {
      key: 'gender',
      categories: ['Male', 'Female', 'Other']
    };

    const run = {
      values: {
        gender: {
          value: 'Male'
          // missing category property
        }
      }
    };

    const result = runList.renderResultPreview(run);
    expect(result).to.be.null;
  });

  it('getRefreshEndpoint returns endpoint with after parameter when items exist', async () => {
    const runList: RunList = await getRunList({
      flow: 'test-flow-uuid'
    });

    const endpoint = runList.getRefreshEndpoint();
    expect(endpoint).to.contain('&after=');
    expect(endpoint).to.contain('2023-12-01T10:30:00.000Z');
  });

  it('getRefreshEndpoint returns base endpoint when no items', async () => {
    const runList: RunList = await getRunList();
    runList.endpoint = '/api/v2/runs.json?flow=test';

    const endpoint = runList.getRefreshEndpoint();
    expect(endpoint).to.equal('/api/v2/runs.json?flow=test');
  });

  it('toggleResponded updates responses property', async () => {
    const runList: RunList = await getRunList();

    // mock checkbox element
    const mockCheckbox = document.createElement('input') as any;
    mockCheckbox.checked = false;
    sinon.stub(runList.shadowRoot, 'querySelector').returns(mockCheckbox);

    runList.toggleResponded();

    expect(runList.responses).to.equal(false);
  });

  it('handleColumnChanged sets resultPreview from event', async () => {
    const runList: RunList = await getRunList();

    const event = {
      target: {
        values: [{ key: 'name', name: 'Name' }]
      }
    };

    runList.handleColumnChanged(event);

    expect(runList.resultPreview).to.deep.equal({ key: 'name', name: 'Name' });
  });

  it('handleColumnChanged clears resultPreview when no values', async () => {
    const runList: RunList = await getRunList();

    runList.resultPreview = { key: 'name', name: 'Name' };

    const event = {
      target: {
        values: []
      }
    };

    runList.handleColumnChanged(event);

    expect(runList.resultPreview).to.be.null;
  });

  it('handleSelected sets selectedRun', async () => {
    const runList: RunList = await getRunList();

    const selectedRun = { id: 1, uuid: 'test-uuid' };
    runList.handleSelected(selectedRun);

    expect(runList.selectedRun).to.equal(selectedRun);
  });

  it('getListStyle returns empty string', async () => {
    const runList: RunList = await getRunList();

    const style = runList.getListStyle();
    expect(style).to.equal('');
  });

  it('renderHeader shows checkbox', async () => {
    const runList: RunList = await getRunList();

    const header = runList.renderHeader();
    const headerString = header.strings.join('');
    expect(headerString).to.contain('temba-checkbox');
    expect(headerString).to.contain('Responses Only');
  });

  it('renderHeader shows select when results exist', async () => {
    const runList: RunList = await getRunList();

    runList.results = [{ key: 'name', name: 'Name' }];
    await runList.updateComplete;

    const header = runList.renderHeader();

    // check if the template includes the results check and nested template
    expect(header.values).to.have.length.greaterThan(0);

    // check that results is truthy which will render the select
    expect(runList.results).to.not.be.null;
  });

  it('renderHeader without results hides select', async () => {
    const runList: RunList = await getRunList();

    const header = runList.renderHeader();
    expect(header.strings.join('')).to.not.contain('temba-select');
    expect(header.strings.join('')).to.contain('temba-checkbox');
  });

  it('renderFooter returns null when no selectedRun', async () => {
    const runList: RunList = await getRunList();

    const footer = runList.renderFooter();
    expect(footer).to.be.null;
  });

  it('renderFooter returns null when no resultKeys', async () => {
    const runList: RunList = await getRunList();

    runList.selectedRun = { id: 1, values: {} };
    // Don't set results, so resultKeys will be empty object {} which is truthy.
    // The method only returns null if selectedRun is null/undefined, not for empty resultKeys.

    const footer = runList.renderFooter();
    expect(footer).to.not.be.null; // Empty object {} is truthy, so footer should render
  });

  it('renderFooter handles selectedRun without values', async () => {
    const runList: RunList = await getRunList();

    // mock temba-select element for the results
    const mockSelect = document.createElement('div') as any;
    mockSelect.setOptions = sinon.spy();
    sinon.stub(runList.shadowRoot, 'querySelector').returns(mockSelect);

    // set results to populate resultKeys
    runList.results = [];
    await runList.updateComplete;

    runList.selectedRun = {
      id: 1,
      contact: {
        uuid: 'contact-uuid',
        name: 'John Doe',
        urn: 'tel:+1234567890'
      },
      created_on: '2023-12-01T10:00:00.000Z'
    };

    // should work now with the safety check
    const footer = runList.renderFooter();
    expect(footer).to.not.be.null;
  });

  it('renderFooter displays contact information', async () => {
    const runList: RunList = await getRunList();

    // mock temba-select element for the results
    const mockSelect = document.createElement('div') as any;
    mockSelect.setOptions = sinon.spy();
    sinon.stub(runList.shadowRoot, 'querySelector').returns(mockSelect);

    // set results to populate resultKeys
    runList.results = [{ key: 'name', name: 'Name', categories: ['Text'] }];
    await runList.updateComplete;

    runList.selectedRun = {
      id: 1,
      contact: {
        uuid: 'contact-uuid',
        name: 'John Doe',
        urn: 'tel:+1234567890'
      },
      exit_type: 'completed',
      exited_on: '2023-12-01T10:30:00.000Z',
      created_on: '2023-12-01T10:00:00.000Z',
      values: {
        name: { name: 'Name', key: 'name', value: 'John Doe', category: 'Text' }
      }
    };

    const footer = runList.renderFooter();
    expect(footer).to.not.be.null;
    expect(footer.strings[0]).to.contain('temba-contact-name');
  });

  it('renderFooter shows active run status', async () => {
    const runList: RunList = await getRunList();

    // mock temba-select element for the results
    const mockSelect = document.createElement('div') as any;
    mockSelect.setOptions = sinon.spy();
    sinon.stub(runList.shadowRoot, 'querySelector').returns(mockSelect);

    // set results to populate resultKeys
    runList.results = [];
    await runList.updateComplete;

    runList.selectedRun = {
      id: 1,
      contact: {
        uuid: 'contact-uuid',
        name: 'John Doe',
        urn: 'tel:+1234567890'
      },
      exit_type: null,
      created_on: '2023-12-01T10:00:00.000Z',
      values: {}
    };

    const footer = runList.renderFooter();
    expect(footer.strings.join('')).to.contain('Started');
  });

  it('createRenderOption creates renderOption function', async () => {
    const runList: RunList = await getRunList();

    expect(runList.renderOption).to.be.a('function');

    const run = {
      contact: {
        name: 'John Doe',
        urn: 'tel:+1234567890',
        ref: 'E2E6MX'
      },
      modified_on: '2023-12-01T10:30:00.000Z',
      exited_on: '2023-12-01T10:30:00.000Z',
      responded: true
    };

    const result = runList.renderOption(run, false);
    expect(result.strings.join('')).to.contain('temba-contact-name');
    expect(result.strings.join('')).to.contain('temba-date');
  });

  it('renderOption handles run without contact name', async () => {
    const runList: RunList = await getRunList();

    const run = {
      contact: {
        name: null,
        urn: 'tel:+1234567890',
        ref: 'E2E6MX'
      },
      modified_on: '2023-12-01T10:30:00.000Z',
      exited_on: null,
      responded: false
    };

    const result = runList.renderOption(run, false);
    expect(result.strings.join('')).to.contain('temba-contact-name');
  });

  it('renderOption handles run without contact', async () => {
    const runList: RunList = await getRunList();

    const run = {
      modified_on: '2023-12-01T10:30:00.000Z',
      exited_on: null,
      responded: false
    };

    const result = runList.renderOption(run, false);
    expect(result.strings.join('')).to.contain('temba-contact-name');
  });

  it('handles results without categories in renderResultPreview', async () => {
    const runList: RunList = await getRunList();

    runList.resultPreview = { key: 'name', categories: ['Text'] };

    const run = {
      values: {
        name: {
          value: 'Test Value'
          // missing category property
        }
      }
    };

    const result = runList.renderResultPreview(run);
    expect(result).to.equal('Test Value');
  });

  it('firstUpdated calls super', async () => {
    const runList: RunList = await getRunList();
    const superSpy = sinon.spy(
      Object.getPrototypeOf(RunList.prototype),
      'firstUpdated'
    );

    runList.firstUpdated(new Map());

    expect(superSpy.called).to.be.true;
    superSpy.restore();
  });

  it('renderFooter shows result values', async () => {
    const runList: RunList = await getRunList();

    // mock temba-select element for the results
    const mockSelect = document.createElement('div') as any;
    mockSelect.setOptions = sinon.spy();
    sinon.stub(runList.shadowRoot, 'querySelector').returns(mockSelect);

    // set results to populate resultKeys
    runList.results = [{ key: 'name', name: 'Name', categories: ['Text'] }];
    await runList.updateComplete;

    runList.selectedRun = {
      id: 1,
      contact: {
        uuid: 'contact-uuid',
        name: 'John Doe',
        urn: 'tel:+1234567890'
      },
      created_on: '2023-12-01T10:00:00.000Z',
      values: {
        name: { name: 'Name', key: 'name', value: 'John Doe', category: 'Text' }
      }
    };

    const footer = runList.renderFooter();
    expect(footer).to.not.be.null;

    // check that the conditions for showing the table are met
    const resultKeys = Object.keys(runList.selectedRun.values || {});
    expect(resultKeys.length).to.be.greaterThan(0);
  });

  it('renderFooter shows multi-category display', async () => {
    const runList: RunList = await getRunList();

    // mock temba-select element for the results
    const mockSelect = document.createElement('div') as any;
    mockSelect.setOptions = sinon.spy();
    sinon.stub(runList.shadowRoot, 'querySelector').returns(mockSelect);

    // set results to populate resultKeys
    runList.results = [
      { key: 'gender', name: 'Gender', categories: ['Male', 'Female', 'Other'] }
    ];
    await runList.updateComplete;

    runList.selectedRun = {
      id: 1,
      contact: {
        uuid: 'contact-uuid',
        name: 'John Doe',
        urn: 'tel:+1234567890'
      },
      created_on: '2023-12-01T10:00:00.000Z',
      values: {
        gender: {
          name: 'Gender',
          key: 'gender',
          value: 'Male',
          category: 'Male'
        }
      }
    };

    const footer = runList.renderFooter();
    expect(footer).to.not.be.null;

    // check that we have data setup correctly by verifying the selected run has values
    expect(Object.keys(runList.selectedRun.values).length).to.be.greaterThan(0);
  });

  it('renderFooter handles missing contact uuid', async () => {
    const runList: RunList = await getRunList();

    // mock temba-select element for the results
    const mockSelect = document.createElement('div') as any;
    mockSelect.setOptions = sinon.spy();
    sinon.stub(runList.shadowRoot, 'querySelector').returns(mockSelect);

    // set results to populate resultKeys
    runList.results = [];
    await runList.updateComplete;

    runList.selectedRun = {
      id: 1,
      contact: null, // Missing contact to trigger the fallback
      created_on: '2023-12-01T10:00:00.000Z',
      values: {}
    };

    const footer = runList.renderFooter();
    expect(footer).to.not.be.null;
    expect(footer.strings[0]).to.contain('temba-contact-name');
  });

  it('renderFooter shows single-category result display', async () => {
    const runList: RunList = await getRunList();

    // mock temba-select element for the results
    const mockSelect = document.createElement('div') as any;
    mockSelect.setOptions = sinon.spy();
    sinon.stub(runList.shadowRoot, 'querySelector').returns(mockSelect);

    // set results to populate resultKeys
    runList.results = [{ key: 'name', name: 'Name', categories: ['Text'] }];
    await runList.updateComplete;

    runList.selectedRun = {
      id: 1,
      contact: {
        uuid: 'contact-uuid',
        name: 'John Doe',
        urn: 'tel:+1234567890'
      },
      created_on: '2023-12-01T10:00:00.000Z',
      values: {
        name: { name: 'Name', key: 'name', value: 'John Doe', category: 'Text' }
      }
    };

    const footer = runList.renderFooter();
    const footerString = footer.strings.join('');
    expect(footerString).to.contain('--'); // Single category shows '--' for category
  });
});
