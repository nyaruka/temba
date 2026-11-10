import { expect } from '@open-wc/testing';
import { say_msg } from '../../src/flow/actions/say_msg';
import { SayMsg } from '../../src/store/flow-definition';
import { ActionTest } from '../ActionHelper';
import {
  resolveToLocalizationFormData,
  resolveFromLocalizationFormData
} from '../../src/flow/utils';

/**
 * Test suite for the say_msg action configuration.
 */
describe('say_msg action config', () => {
  const helper = new ActionTest(say_msg, 'say_msg');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(say_msg.name).to.equal('Say Message');
    });

    it('is voice-only', () => {
      expect(say_msg.flowTypes).to.deep.equal(['voice']);
    });
  });

  describe('action scenarios', () => {
    helper.testEditor(
      {
        uuid: 'test-say-1',
        type: 'say_msg',
        text: 'Hello, welcome to our service.'
      } as SayMsg,
      'missing-feature',
      []
    );

    helper.testAction(
      {
        uuid: 'test-say-1',
        type: 'say_msg',
        text: 'Hello, welcome to our service.'
      } as SayMsg,
      'simple-text'
    );

    helper.testAction(
      {
        uuid: 'test-say-2',
        type: 'say_msg',
        text: 'Press 1 for sales.\nPress 2 for support.\nPress 3 to leave a message.'
      } as SayMsg,
      'multiline-text'
    );

    helper.testAction(
      {
        uuid: 'test-say-3',
        type: 'say_msg',
        text: 'Please listen to the following recording.',
        audio_url: 'https://example.com/greeting.mp3'
      } as SayMsg,
      'text-with-audio-url'
    );
  });

  describe('data transformation', () => {
    it('converts action to form data', () => {
      const action: SayMsg = {
        uuid: 'test-action',
        type: 'say_msg',
        text: 'Hello world',
        audio_url: 'https://example.com/audio.mp3'
      };

      const formData = say_msg.toFormData!(action);
      expect(formData.uuid).to.equal('test-action');
      expect(formData.text).to.equal('Hello world');
      expect(formData.audio_url).to.equal('https://example.com/audio.mp3');
    });

    it('handles missing audio_url in toFormData', () => {
      const action: SayMsg = {
        uuid: 'test-action',
        type: 'say_msg',
        text: 'Hello'
      } as SayMsg;

      const formData = say_msg.toFormData!(action);
      expect(formData.audio_url).to.equal('');
    });

    it('converts form data to action', () => {
      const formData = {
        uuid: 'test-action',
        text: 'Hello world',
        audio_url: 'https://example.com/audio.mp3'
      };

      const action = say_msg.fromFormData!(formData) as SayMsg;
      expect(action.uuid).to.equal('test-action');
      expect(action.type).to.equal('say_msg');
      expect(action.text).to.equal('Hello world');
      expect(action.audio_url).to.equal('https://example.com/audio.mp3');
    });

    it('omits empty audio_url in fromFormData', () => {
      const formData = {
        uuid: 'test-action',
        text: 'Hello world',
        audio_url: ''
      };

      const action = say_msg.fromFormData!(formData) as SayMsg;
      expect(action.audio_url).to.be.undefined;
    });

    it('trims whitespace from audio_url', () => {
      const formData = {
        uuid: 'test-action',
        text: 'Hello',
        audio_url: '  https://example.com/audio.mp3  '
      };

      const action = say_msg.fromFormData!(formData) as SayMsg;
      expect(action.audio_url).to.equal('https://example.com/audio.mp3');
    });
  });

  describe('sanitize', () => {
    it('trims text whitespace', () => {
      const formData = { text: '  Hello world  ' };
      say_msg.sanitize!(formData);
      expect(formData.text).to.equal('Hello world');
    });
  });

  describe('localization', () => {
    it('converts localization to form data', () => {
      const action: SayMsg = {
        uuid: 'test-action',
        type: 'say_msg',
        text: 'Hello',
        audio_url: 'https://example.com/en.mp3'
      };

      const localization = {
        text: ['Hola'],
        audio_url: ['https://example.com/es.mp3']
      };

      const formData = resolveToLocalizationFormData(say_msg)!(
        action,
        localization
      );
      expect(formData.text).to.equal('Hola');
      expect(formData.audio_url).to.equal('https://example.com/es.mp3');
    });

    it('handles missing localization fields', () => {
      const action: SayMsg = {
        uuid: 'test-action',
        type: 'say_msg',
        text: 'Hello'
      } as SayMsg;

      const formData = resolveToLocalizationFormData(say_msg)!(action, {});
      expect(formData.text).to.equal('');
      expect(formData.audio_url).to.equal('');
    });

    it('converts form data to localization', () => {
      const action: SayMsg = {
        uuid: 'test-action',
        type: 'say_msg',
        text: 'Hello',
        audio_url: 'https://example.com/en.mp3'
      };

      const formData = {
        uuid: 'test-action',
        text: 'Hola',
        audio_url: 'https://example.com/es.mp3'
      };

      const localization = resolveFromLocalizationFormData(say_msg)!(
        formData,
        action
      );
      expect(localization.text).to.deep.equal(['Hola']);
      expect(localization.audio_url).to.deep.equal([
        'https://example.com/es.mp3'
      ]);
    });

    it('omits unchanged localization fields', () => {
      const action: SayMsg = {
        uuid: 'test-action',
        type: 'say_msg',
        text: 'Hello',
        audio_url: 'https://example.com/en.mp3'
      };

      const formData = {
        uuid: 'test-action',
        text: 'Hello', // same as original
        audio_url: 'https://example.com/en.mp3' // same as original
      };

      const localization = resolveFromLocalizationFormData(say_msg)!(
        formData,
        action
      );
      expect(localization.text).to.be.undefined;
      expect(localization.audio_url).to.be.undefined;
    });
  });
});
