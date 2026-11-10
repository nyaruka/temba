import { html } from 'lit-html';
import {
  ActionConfig,
  ACTION_GROUPS,
  FormData,
  FlowTypes,
  Features
} from '../types';
import { Node, PlayAudio } from '../../store/flow-definition';
import { renderHighlightedText } from '../utils';

export const play_audio: ActionConfig = {
  name: 'Play Recording',
  subtitle: 'Use a recorded prompt instead of text-to-speech.',
  group: ACTION_GROUPS.send,
  flowTypes: [FlowTypes.VOICE],
  needs: {
    feature: Features.IVR,
    warning: 'This workspace has no voice channel.'
  },
  render: (_node: Node, action: PlayAudio) => {
    return html`
      <div style="display: flex; align-items: center; gap: 0.3em;">
        <temba-icon name="recording" size="1"></temba-icon>
        <div
          style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;"
          title="${action.audio_url || ''}"
        >
          ${renderHighlightedText(action.audio_url || '', true)}
        </div>
      </div>
    `;
  },
  form: {
    audio_url: {
      type: 'text',
      label: 'Recording URL',
      required: true,
      maxLength: 8192,
      evaluated: true
    }
  },
  layout: ['audio_url'],
  toFormData: (action: PlayAudio) => {
    return {
      uuid: action.uuid,
      audio_url: action.audio_url || ''
    };
  },
  fromFormData: (data: FormData) => {
    return {
      uuid: data.uuid,
      type: 'play_audio',
      audio_url: (data.audio_url || '').trim()
    } as PlayAudio;
  },
  localizable: ['audio_url']
};
