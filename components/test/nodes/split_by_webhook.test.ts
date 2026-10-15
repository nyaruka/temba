import { expect } from '@open-wc/testing';
import { split_by_webhook } from '../../src/flow/nodes/split_by_webhook';
import { Node, CallWebhook } from '../../src/store/flow-definition';
import { NodeTest } from '../NodeHelper';

/**
 * Test suite for the split_by_webhook node configuration.
 */
describe('split_by_webhook node config', () => {
  const helper = new NodeTest(split_by_webhook, 'split_by_webhook');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct type and name', () => {
      expect(split_by_webhook.type).to.equal('split_by_webhook');
      expect(split_by_webhook.name).to.equal('Call Webhook');
    });
  });

  describe('extras', () => {
    const section = (label: string) =>
      (
        split_by_webhook.layout!.find(
          (item: any) => item.type === 'extras'
        ) as any
      ).sections.find((s: any) => s.label === label);

    it('only shows headers that differ from the defaults', () => {
      const headers = section('Headers');
      expect(
        headers.hasValue({
          headers: [
            { key: 'Accept', value: 'application/json' },
            { key: 'Content-Type', value: 'application/json' }
          ]
        })
      ).to.be.false;
      expect(
        headers.hasValue({
          headers: [{ key: 'Authorization', value: 'Token abc' }]
        })
      ).to.be.true;
    });

    it('restores the default headers and body when removed', () => {
      const post = { method: [{ value: 'POST', name: 'POST' }] };
      expect(section('Headers').onRemove(post)).to.deep.equal({
        headers: [
          { key: 'Accept', value: 'application/json' },
          { key: 'Content-Type', value: 'application/json' }
        ]
      });
      expect(section('Body').onRemove(post).body).to.contain('@(json(');
      expect(section('Body').onRemove({ method: 'GET' })).to.deep.equal({
        body: ''
      });
      expect(section('Body').hasValue(section('Body').onRemove(post))).to.be
        .false;
    });

    it('offers the result name as an extra', () => {
      expect(section('Save Result').items).to.deep.equal(['result_name']);
    });
  });

  describe('node scenarios', () => {
    it('renders custom headers', async () => {
      const node = split_by_webhook.fromFormData!(
        {
          uuid: 'webhook-node',
          method: [{ value: 'GET', name: 'GET' }],
          url: 'https://example.com/lookup?phone=@urns.tel',
          headers: [
            { key: 'Accept', value: 'application/json' },
            { key: 'Authorization', value: 'Token @globals.api_token' }
          ],
          body: '',
          result_name: 'lookup'
        },
        { uuid: 'webhook-node', actions: [], exits: [] }
      );

      await helper.testNode(
        node,
        { type: 'split_by_webhook' },
        'custom-headers'
      );
    });
  });

  describe('round-trip transformation', () => {
    it('should transform from flow definition to form data', () => {
      const node: Node = {
        uuid: 'test-node',
        actions: [
          {
            type: 'call_webhook',
            uuid: 'action-1',
            method: 'POST',
            url: 'https://example.com/webhook',
            headers: { Authorization: 'Bearer token123' },
            body: '{"key": "value"}'
          } as CallWebhook
        ],
        exits: []
      };

      const formData = split_by_webhook.toFormData!(node);

      expect(formData.uuid).to.equal('test-node');
      expect(formData.method).to.equal('POST');
      expect(formData.url).to.equal('https://example.com/webhook');
      expect(formData.headers).to.deep.equal({
        Authorization: 'Bearer token123'
      });
      expect(formData.body).to.equal('{"key": "value"}');
    });

    it('should transform from form data to flow definition (GET)', () => {
      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: []
      };

      const formData = {
        uuid: 'test-node',
        method: [{ value: 'GET', name: 'GET' }],
        url: 'https://example.com/api',
        headers: [],
        body: ''
      };

      const resultNode = split_by_webhook.fromFormData!(formData, originalNode);

      expect(resultNode.uuid).to.equal('test-node');
      expect(resultNode.actions).to.have.lengthOf(1);
      expect(resultNode.actions![0].type).to.equal('call_webhook');

      const action = resultNode.actions![0] as any;
      expect(action.method).to.equal('GET');
      expect(action.url).to.equal('https://example.com/api');

      // Should have Success/Failure router
      expect(resultNode.router).to.exist;
      expect(resultNode.router!.type).to.equal('switch');
      // operand uses default() so a null @webhook (e.g. skipped call) routes
      // to Failure without evaluation errors
      expect(resultNode.router!.operand).to.equal(
        '@(default(webhook.status, 0))'
      );
      expect(resultNode.exits).to.have.lengthOf(2);
    });

    it('should upgrade legacy @webhook.status operand on re-save', () => {
      const originalNode: Node = {
        uuid: 'test-node',
        actions: [
          {
            type: 'call_webhook',
            uuid: 'existing-action-uuid',
            method: 'GET',
            url: 'https://example.com/api'
          } as CallWebhook
        ],
        router: {
          type: 'switch',
          cases: [
            {
              uuid: 'existing-case-uuid',
              type: 'has_number_between',
              arguments: ['200', '299'],
              category_uuid: 'existing-success-uuid'
            }
          ],
          categories: [
            {
              uuid: 'existing-success-uuid',
              name: 'Success',
              exit_uuid: 'existing-success-exit-uuid'
            },
            {
              uuid: 'existing-failure-uuid',
              name: 'Failure',
              exit_uuid: 'existing-failure-exit-uuid'
            }
          ],
          default_category_uuid: 'existing-failure-uuid',
          operand: '@webhook.status'
        } as any,
        exits: [
          {
            uuid: 'existing-success-exit-uuid',
            destination_uuid: 'some-node-uuid'
          },
          {
            uuid: 'existing-failure-exit-uuid',
            destination_uuid: 'another-node-uuid'
          }
        ]
      };

      const formData = {
        uuid: 'test-node',
        method: [{ value: 'GET', name: 'GET' }],
        url: 'https://example.com/api',
        headers: [],
        body: ''
      };

      const resultNode = split_by_webhook.fromFormData!(formData, originalNode);

      // operand should be upgraded to the null-safe form
      expect(resultNode.router!.operand).to.equal(
        '@(default(webhook.status, 0))'
      );

      // everything else should be preserved
      expect(resultNode.actions![0].uuid).to.equal('existing-action-uuid');
      expect(resultNode.router!.cases![0].uuid).to.equal('existing-case-uuid');
      expect(resultNode.router!.categories![0].uuid).to.equal(
        'existing-success-uuid'
      );
      expect(resultNode.exits![0].destination_uuid).to.equal('some-node-uuid');
      expect(resultNode.exits![1].destination_uuid).to.equal(
        'another-node-uuid'
      );
    });

    it('should transform from form data to flow definition (POST)', () => {
      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: []
      };

      const formData = {
        uuid: 'test-node',
        method: [{ value: 'POST', name: 'POST' }],
        url: 'https://example.com/webhook',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        body: '{"data": "@contact.name"}'
      };

      const resultNode = split_by_webhook.fromFormData!(formData, originalNode);

      const action = resultNode.actions![0] as any;
      expect(action.method).to.equal('POST');
      expect(action.url).to.equal('https://example.com/webhook');
      expect(action.headers).to.have.lengthOf(1);
      expect(action.body).to.equal('{"data": "@contact.name"}');
    });

    it('should provide default GET headers for new actions', () => {
      const node: Node = {
        uuid: 'test-node',
        actions: [],
        exits: []
      };

      const formData = split_by_webhook.toFormData!(node);

      expect(formData.headers).to.deep.equal({
        Accept: 'application/json'
      });
    });

    it('should provide default POST headers for new POST actions', () => {
      const node: Node = {
        uuid: 'test-node',
        actions: [
          {
            type: 'call_webhook',
            uuid: 'action-1',
            method: 'POST',
            url: 'https://example.com',
            headers: {},
            body: ''
          } as CallWebhook
        ],
        exits: []
      };

      // When headers are empty object, should get POST defaults
      const formData = split_by_webhook.toFormData!(node);

      // Empty object from existing action is preserved (not replaced with defaults)
      expect(formData.headers).to.deep.equal({});
    });

    it('should preserve existing headers for existing actions', () => {
      const node: Node = {
        uuid: 'test-node',
        actions: [
          {
            type: 'call_webhook',
            uuid: 'action-1',
            method: 'GET',
            url: 'https://example.com',
            headers: { 'X-Custom': 'value' }
          } as CallWebhook
        ],
        exits: []
      };

      const formData = split_by_webhook.toFormData!(node);

      expect(formData.headers).to.deep.equal({ 'X-Custom': 'value' });
    });

    it('should preserve action UUID on re-save', () => {
      const originalNode: Node = {
        uuid: 'test-node',
        actions: [
          {
            type: 'call_webhook',
            uuid: 'existing-action-uuid',
            method: 'GET',
            url: 'https://example.com/old'
          } as CallWebhook
        ],
        exits: []
      };

      const formData = {
        uuid: 'test-node',
        method: [{ value: 'GET', name: 'GET' }],
        url: 'https://example.com/new',
        headers: [],
        body: ''
      };

      const resultNode = split_by_webhook.fromFormData!(formData, originalNode);

      expect(resultNode.actions![0].uuid).to.equal('existing-action-uuid');
    });
  });

  describe('legacy webhook result_name support', () => {
    // Legacy webhooks (from the old flow editor) store the result_name on the
    // call_webhook action. Modern webhooks store it on the router. These must
    // be supported in parallel — editing a legacy webhook must keep it legacy
    // because the placement changes how the result is referenced downstream.

    const legacyNode: Node = {
      uuid: 'd02536d0-7e86-47ab-8c60-fcf2678abc2b',
      actions: [
        {
          type: 'call_webhook',
          uuid: '9aa018e7-4934-457a-b582-63b164c562f7',
          method: 'GET',
          url: 'http://localhost/?cmd=country',
          result_name: 'Country Webhook'
        } as CallWebhook
      ],
      router: {
        type: 'switch',
        operand: '@results.country_webhook.category',
        categories: [],
        cases: []
      } as any,
      exits: []
    };

    const modernNode: Node = {
      uuid: 'd02536d0-7e86-47ab-8c60-fcf2678abc2b',
      actions: [
        {
          type: 'call_webhook',
          uuid: '9aa018e7-4934-457a-b582-63b164c562f7',
          method: 'GET',
          url: 'http://localhost/?cmd=country'
        } as CallWebhook
      ],
      router: {
        type: 'switch',
        operand: '@webhook.status',
        result_name: 'Country Webhook',
        categories: [],
        cases: []
      } as any,
      exits: []
    };

    it('reads result_name from the action for legacy webhooks', () => {
      const formData = split_by_webhook.toFormData!(legacyNode);
      expect(formData.result_name).to.equal('Country Webhook');
    });

    it('reads result_name from the router for modern webhooks', () => {
      const formData = split_by_webhook.toFormData!(modernNode);
      expect(formData.result_name).to.equal('Country Webhook');
    });

    it('keeps result_name on the action when editing a legacy webhook', () => {
      const formData = {
        uuid: legacyNode.uuid,
        method: [{ value: 'GET', name: 'GET' }],
        url: 'http://localhost/?cmd=country',
        headers: [],
        body: '',
        result_name: 'Country Webhook'
      };

      const resultNode = split_by_webhook.fromFormData!(formData, legacyNode);

      const action = resultNode.actions![0] as CallWebhook;
      expect(action.result_name).to.equal('Country Webhook');
      // Should NOT also be duplicated onto the router
      expect(resultNode.router!.result_name).to.be.undefined;
    });

    it('keeps result_name on the router when editing a modern webhook', () => {
      const formData = {
        uuid: modernNode.uuid,
        method: [{ value: 'GET', name: 'GET' }],
        url: 'http://localhost/?cmd=country',
        headers: [],
        body: '',
        result_name: 'Country Webhook'
      };

      const resultNode = split_by_webhook.fromFormData!(formData, modernNode);

      expect(resultNode.router!.result_name).to.equal('Country Webhook');
      const action = resultNode.actions![0] as CallWebhook;
      expect(action.result_name).to.be.undefined;
    });

    it('stores result_name on the router for brand new webhooks', () => {
      const newNode: Node = {
        uuid: 'new-node',
        actions: [],
        exits: []
      };

      const formData = {
        uuid: 'new-node',
        method: [{ value: 'GET', name: 'GET' }],
        url: 'https://example.com/api',
        headers: [],
        body: '',
        result_name: 'My Result'
      };

      const resultNode = split_by_webhook.fromFormData!(formData, newNode);

      expect(resultNode.router!.result_name).to.equal('My Result');
      const action = resultNode.actions![0] as CallWebhook;
      expect(action.result_name).to.be.undefined;
    });

    it('round-trips a legacy webhook without migrating it to the modern format', () => {
      const formData = split_by_webhook.toFormData!(legacyNode);
      const resultNode = split_by_webhook.fromFormData!(formData, legacyNode);

      const action = resultNode.actions![0] as CallWebhook;
      expect(action.result_name).to.equal('Country Webhook');
      expect(resultNode.router!.result_name).to.be.undefined;
    });

    it('drops the action result_name when a legacy webhook clears it', () => {
      const formData = {
        uuid: legacyNode.uuid,
        method: [{ value: 'GET', name: 'GET' }],
        url: 'http://localhost/?cmd=country',
        headers: [],
        body: '',
        result_name: ''
      };

      const resultNode = split_by_webhook.fromFormData!(formData, legacyNode);

      const action = resultNode.actions![0] as CallWebhook;
      expect(action.result_name).to.be.undefined;
      expect(resultNode.router!.result_name).to.be.undefined;
    });
  });
});
