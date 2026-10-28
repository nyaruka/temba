import { expect, fixture, html } from '@open-wc/testing';
import { FieldRenderer } from '../src/form/FieldRenderer';
import {
  TextFieldConfig,
  TextareaFieldConfig,
  SelectFieldConfig,
  CheckboxFieldConfig,
  KeyValueFieldConfig,
  MessageEditorFieldConfig,
  TemplateEditorFieldConfig
} from '../src/flow/types';
import { assertScreenshot, getClip } from './utils.test';

describe('FieldRenderer', () => {
  describe('text fields', () => {
    it('should render text field with label', async () => {
      const config: TextFieldConfig = {
        type: 'text',
        label: 'Website URL',
        placeholder: 'Enter URL'
      };

      const template = FieldRenderer.renderField(
        'url',
        config,
        'https://example.com',
        {
          errors: [],
          showLabel: true,
          onChange: () => {}
        }
      );

      const container = await fixture(
        html`<div style="width: 400px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/text-with-label',
        getClip(container as HTMLElement)
      );
    });

    it('should render evaluated text field with completion', async () => {
      const config: TextFieldConfig = {
        type: 'text',
        label: 'Dynamic URL',
        evaluated: true,
        placeholder: 'Enter URL with expressions'
      };

      const template = FieldRenderer.renderField(
        'url',
        config,
        'https://api.com/@contact.name',
        {
          errors: [],
          showLabel: true,
          onChange: () => {}
        }
      );

      const container = await fixture(
        html`<div style="width: 400px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/text-evaluated',
        getClip(container as HTMLElement)
      );
    });

    it('should render text field without label for ArrayEditor context', async () => {
      const config: TextFieldConfig = {
        type: 'text',
        label: 'Item Name',
        placeholder: 'Enter name'
      };

      const template = FieldRenderer.renderField(
        'name',
        config,
        'Sample Item',
        {
          errors: [],
          showLabel: false,
          flavor: 'small',
          extraClasses: 'form-control',
          onChange: () => {}
        }
      );

      const container = await fixture(
        html`<div style="width: 300px; padding: 10px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/text-no-label',
        getClip(container as HTMLElement)
      );
    });

    it('should render text field with errors', async () => {
      const config: TextFieldConfig = {
        type: 'text',
        label: 'Email Address',
        placeholder: 'Enter email'
      };

      const template = FieldRenderer.renderField(
        'email',
        config,
        'invalid-email',
        {
          errors: ['Invalid email format', 'Email is required'],
          showLabel: true,
          onChange: () => {}
        }
      );

      const container = await fixture(
        html`<div style="width: 400px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/text-with-errors',
        getClip(container as HTMLElement)
      );
    });
  });

  describe('optional marker', () => {
    const renderLabel = async (
      config: TextFieldConfig,
      markOptional: boolean
    ): Promise<HTMLElement> => {
      const template = FieldRenderer.renderField('name', config, '', {
        errors: [],
        showLabel: true,
        markOptional,
        onChange: () => {}
      });
      const container = await fixture(html`<div>${template}</div>`);
      const input = container.querySelector('temba-textinput') as any;
      await input.updateComplete;
      return input.shadowRoot.querySelector('label');
    };

    it('marks fields that are explicitly not required', async () => {
      const label = await renderLabel(
        { type: 'text', label: 'Category', required: false },
        true
      );
      expect(label.querySelector('.optional').textContent).to.equal('Optional');

      const container = await fixture(
        html`<div style="width: 400px; padding: 20px;">
          ${FieldRenderer.renderField(
            'name',
            { type: 'text', label: 'Category', required: false },
            '',
            { errors: [], showLabel: true, markOptional: true }
          )}
        </div>`
      );
      await assertScreenshot(
        'field-renderer/text-optional',
        getClip(container as HTMLElement)
      );
    });

    it('does not mark fields with required unset or true', async () => {
      for (const required of [undefined, true]) {
        const label = await renderLabel(
          { type: 'text', label: 'Name', required },
          true
        );
        expect(label.querySelector('.optional')).to.be.null;
      }
    });

    it('does not mark fields unless asked to', async () => {
      const label = await renderLabel(
        { type: 'text', label: 'Category', required: false },
        false
      );
      expect(label.querySelector('.optional')).to.be.null;
    });
  });

  describe('textarea fields', () => {
    it('should render textarea with label', async () => {
      const config: TextareaFieldConfig = {
        type: 'textarea',
        label: 'Description',
        placeholder: 'Enter description',
        rows: 4
      };

      const template = FieldRenderer.renderField(
        'description',
        config,
        'This is a sample description\nwith multiple lines',
        {
          errors: [],
          showLabel: true,
          onChange: () => {}
        }
      );

      const container = await fixture(
        html`<div style="width: 400px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/textarea-with-label',
        getClip(container as HTMLElement)
      );
    });

    it('should render evaluated textarea with completion', async () => {
      const config: TextareaFieldConfig = {
        type: 'textarea',
        label: 'Message Template',
        evaluated: true,
        placeholder: 'Enter message with expressions',
        rows: 3
      };

      const template = FieldRenderer.renderField(
        'message',
        config,
        'Hello @contact.name,\nYour order is ready!',
        {
          errors: [],
          showLabel: true,
          onChange: () => {}
        }
      );

      const container = await fixture(
        html`<div style="width: 400px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/textarea-evaluated',
        getClip(container as HTMLElement)
      );
    });
  });

  describe('select fields', () => {
    it('should render select field with label', async () => {
      const config: SelectFieldConfig = {
        type: 'select',
        label: 'Country',
        options: ['United States', 'Canada', 'United Kingdom', 'Australia'],
        searchable: true
      };

      const template = FieldRenderer.renderField(
        'country',
        config,
        [{ name: 'Canada', value: 'Canada' }],
        {
          errors: [],
          showLabel: true,
          onChange: () => {}
        }
      );

      const container = await fixture(
        html`<div style="width: 400px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/select-with-label',
        getClip(container as HTMLElement)
      );
    });

    it('should render multi-select field', async () => {
      const config: SelectFieldConfig = {
        type: 'select',
        label: 'Skills',
        options: ['JavaScript', 'Python', 'TypeScript', 'React', 'Node.js'],
        multi: true,
        tags: true
      };

      const template = FieldRenderer.renderField(
        'skills',
        config,
        [
          { name: 'JavaScript', value: 'JavaScript' },
          { name: 'TypeScript', value: 'TypeScript' }
        ],
        {
          errors: [],
          showLabel: true,
          onChange: () => {}
        }
      );

      const container = await fixture(
        html`<div style="width: 400px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/select-multi',
        getClip(container as HTMLElement)
      );
    });

    it('should render select field without label for ArrayEditor context', async () => {
      const config: SelectFieldConfig = {
        type: 'select',
        label: 'Status',
        options: ['Active', 'Inactive', 'Pending']
      };

      const template = FieldRenderer.renderField(
        'status',
        config,
        [{ name: 'Active', value: 'Active' }],
        {
          errors: [],
          showLabel: false,
          flavor: 'small',
          extraClasses: 'form-control',
          onChange: () => {}
        }
      );

      const container = await fixture(
        html`<div style="width: 200px; padding: 10px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/select-no-label',
        getClip(container as HTMLElement)
      );
    });
  });

  describe('checkbox fields', () => {
    it('should render checkbox with label', async () => {
      const config: CheckboxFieldConfig = {
        type: 'checkbox',
        label: 'Accept Terms and Conditions'
      };

      const template = FieldRenderer.renderField('accept', config, true, {
        errors: [],
        showLabel: true,
        onChange: () => {}
      });

      const container = await fixture(
        html`<div style="width: 400px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/checkbox-checked',
        getClip(container as HTMLElement)
      );
    });

    it('should render unchecked checkbox', async () => {
      const config: CheckboxFieldConfig = {
        type: 'checkbox',
        label: 'Subscribe to newsletter'
      };

      const template = FieldRenderer.renderField('subscribe', config, false, {
        errors: [],
        showLabel: true,
        onChange: () => {}
      });

      const container = await fixture(
        html`<div style="width: 400px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/checkbox-unchecked',
        getClip(container as HTMLElement)
      );
    });

    it('should render checkbox with errors', async () => {
      const config: CheckboxFieldConfig = {
        type: 'checkbox',
        label: 'Agree to terms',
        required: true
      };

      const template = FieldRenderer.renderField('terms', config, false, {
        errors: ['You must accept the terms to continue'],
        showLabel: true,
        onChange: () => {}
      });

      const container = await fixture(
        html`<div style="width: 400px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/checkbox-with-errors',
        getClip(container as HTMLElement)
      );
    });
  });

  describe('key-value fields', () => {
    it('should render key-value field with label', async () => {
      const config: KeyValueFieldConfig = {
        type: 'key-value',
        label: 'HTTP Headers',
        keyPlaceholder: 'Header name',
        valuePlaceholder: 'Header value'
      };

      const template = FieldRenderer.renderField(
        'headers',
        config,
        [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Authorization', value: 'Bearer token123' }
        ],
        {
          errors: [],
          showLabel: true,
          onChange: () => {}
        }
      );

      const container = await fixture(
        html`<div style="width: 500px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/key-value-with-label',
        getClip(container as HTMLElement)
      );
    });
  });

  describe('message-editor fields', () => {
    it('should render message-editor with label', async () => {
      const config: MessageEditorFieldConfig = {
        type: 'message-editor',
        label: 'Email Message',
        placeholder: 'Enter your message...',
        minHeight: 120
      };

      const template = FieldRenderer.renderField(
        'message',
        config,
        'Hello! This is a test message.',
        {
          errors: [],
          showLabel: true,
          onChange: () => {},
          additionalData: { attachments: [] }
        }
      );

      const container = await fixture(
        html`<div style="width: 500px; padding: 20px;">${template}</div>`
      );
      await assertScreenshot(
        'field-renderer/message-editor-with-label',
        getClip(container as HTMLElement)
      );
    });
  });

  describe('template-editor fields', () => {
    it('should enable session completion for template variables', async () => {
      const config: TemplateEditorFieldConfig = {
        type: 'template-editor',
        endpoint: '/api/internal/templates.json'
      };

      const template = FieldRenderer.renderField(
        'template',
        config,
        { uuid: 'template-123' },
        {
          additionalData: { template_variables: ['@contact.name'] },
          onChange: () => {}
        }
      );

      const container = await fixture(html`<div>${template}</div>`);
      const templateEditor = container.querySelector(
        'temba-template-editor'
      ) as HTMLElement;

      expect(templateEditor).to.exist;
      expect(templateEditor.hasAttribute('session')).to.be.true;
    });
  });

  describe('field consistency', () => {
    it('should render the same field type consistently between contexts', async () => {
      const config: TextFieldConfig = {
        type: 'text',
        label: 'Product Name',
        placeholder: 'Enter product name'
      };

      // NodeEditor context (with label)
      const nodeEditorTemplate = FieldRenderer.renderField(
        'product',
        config,
        'iPhone 15',
        {
          errors: [],
          showLabel: true,
          onChange: () => {}
        }
      );

      // ArrayEditor context (without label)
      const arrayEditorTemplate = FieldRenderer.renderField(
        'product',
        config,
        'iPhone 15',
        {
          errors: [],
          showLabel: false,
          flavor: 'small',
          extraClasses: 'form-control',
          onChange: () => {}
        }
      );

      const nodeContainer = await fixture(
        html`<div
          style="width: 400px; padding: 20px; border: 1px solid #ddd; margin: 10px;"
        >
          <h3 style="margin: 0 0 10px 0; font-size: 14px; color: #666;">
            NodeEditor Context
          </h3>
          ${nodeEditorTemplate}
        </div>`
      );

      const arrayContainer = await fixture(
        html`<div
          style="width: 400px; padding: 20px; border: 1px solid #ddd; margin: 10px;"
        >
          <h3 style="margin: 0 0 10px 0; font-size: 14px; color: #666;">
            ArrayEditor Context
          </h3>
          ${arrayEditorTemplate}
        </div>`
      );

      const combinedContainer = await fixture(
        html`<div style="display: flex; flex-direction: column; width: 420px;">
          ${nodeContainer} ${arrayContainer}
        </div>`
      );

      await assertScreenshot(
        'field-renderer/context-comparison',
        getClip(combinedContainer as HTMLElement)
      );
    });
  });

  describe('error handling', () => {
    it('should handle all field types without throwing errors', () => {
      const configs = [
        { type: 'text', label: 'Text' } as TextFieldConfig,
        { type: 'textarea', label: 'Textarea' } as TextareaFieldConfig,
        { type: 'select', label: 'Select', options: [] } as SelectFieldConfig,
        { type: 'checkbox', label: 'Checkbox' },
        { type: 'key-value', label: 'KeyValue' },
        { type: 'array', label: 'Array', itemConfig: {} },
        { type: 'message-editor', label: 'MessageEditor' }
      ];

      configs.forEach((config, index) => {
        expect(() => {
          FieldRenderer.renderField(`field${index}`, config as any, null, {
            errors: [],
            showLabel: true,
            onChange: () => {}
          });
        }).to.not.throw;
      });
    });
  });
});
