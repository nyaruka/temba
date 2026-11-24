/* eslint-disable @typescript-eslint/no-this-alias */
import { html, css, PropertyValueMap } from 'lit';
import { CroppieCSS } from './CroppieCSS';
import { property } from 'lit/decorators.js';
import { Icon } from '../Icons';
import { FieldElement } from './FieldElement';

export class ImagePicker extends FieldElement {
  static get styles() {
    return css`
      ${super.styles}
      ${CroppieCSS}

      .croppie {
        max-width: 400px;
        border: 0px solid #ccc;
        border-radius: 0.5em;
        overflow: hidden;
        background: #fff;
        margin-top: -20%;
        box-shadow: 0 0 15px 5px rgba(0, 0, 0, 0.1);
      }

      .croppie .controls {
        display: flex;
        align-items: center;
        flex-direction: row;
        justify-content: center;
        position: absolute;
        z-index: 1;
        width: 400px;
        margin-top: -42px;
      }

      .toggle {
        height: 110px;
        width: 110px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .circle .toggle {
        border-radius: 50%;
      }

      .toggle.set {
        box-shadow:
          rgba(0, 0, 0, 0.1) 0px 3px 7px 0px,
          rgba(0, 0, 0, 0.2) 0px 1px 2px 0px,
          inset 0 0 0 5px rgba(0, 0, 0, 0.1);
      }

      .toggle.set:hover {
        box-shadow:
          rgba(0, 0, 0, 0.1) 0px 3px 7px 0px,
          rgba(0, 0, 0, 0.2) 0px 1px 2px 0px,
          inset 0 0 0 5px rgba(0, 0, 0, 0.2);
      }

      .toggle temba-icon {
        color: rgba(0, 0, 0, 0.2);
        padding: 5px;
      }

      toggle:hover temba-icon {
        color: rgba(0, 0, 0, 0.8);
      }

      .toggle.set temba-icon {
        border-radius: 50%;
        margin-right: -90%;
        margin-bottom: -50%;
        background: rgba(240, 240, 240, 1);
        box-shadow: rgba(0, 0, 0, 0.2) 0px 1px 2px 0px;
      }

      .toggle.set:hover temba-icon {
        background: #fff;
        color: var(--color-primary-dark);
      }

      .circle .toggle.set temba-icon {
        margin-right: -70%;
        margin-bottom: -70%;
      }

      .hidden {
        display: none;
      }

      .toggle-wrapper {
        position: relative;
        display: inline-block;
      }

      .clear {
        position: absolute;
        top: -8px;
        right: -8px;
        border-radius: 50%;
        padding: 4px;
        background: rgba(240, 240, 240, 1);
        box-shadow: rgba(0, 0, 0, 0.2) 0px 1px 2px 0px;
        color: rgba(0, 0, 0, 0.5);
        cursor: pointer;
      }

      .clear:hover {
        background: #fff;
        color: var(--color-primary-dark);
      }

      .controls temba-icon {
        margin: 0em 0.75em;
        background: rgba(255, 255, 255, 0.8);
        border-radius: 50%;
        padding: 6px;
        transition: all 0.1s ease-in-out;
      }

      .controls {
        pointer-events: none;
        display: flex;
      }

      .controls temba-icon {
        pointer-events: all;
      }

      .controls temba-icon.close {
        color: rgba(0, 0, 0, 0.2);
        background: rgba(255, 255, 255, 0.2);
      }

      .controls temba-icon.submit {
        color: rgba(0, 0, 0, 0.2);
        box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.1);
      }

      .controls temba-icon:hover {
        color: white;
        cursor: pointer;
        background: var(--color-primary-dark);
      }
    `;
  }

  @property({ type: String })
  tempImage: string;

  @property({ type: String })
  url: string;

  @property({ type: String })
  shape = 'square';

  @property({ type: Boolean, attribute: false })
  showCroppie = false;

  // whether the image can be removed - which is posted as the <name>-clear flag Django's ClearableFileInput reads
  @property({ type: Boolean })
  clearable = false;

  uploadReader = new FileReader();
  croppie: any;

  protected firstUpdated(
    changed: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    super.firstUpdated(changed);
    const picker = this;

    this.uploadReader.onload = function () {
      picker.launchCroppie(picker.uploadReader.result as any);
    };
  }

  public updated(changed: Map<string, any>): void {
    super.updated(changed);
    if (changed.has('url')) {
      if (this.url) {
        this.setAttribute('url', this.url);
      } else {
        this.removeAttribute('url');
      }
    }
  }

  private closeCroppie() {
    this.showCroppie = false;
    const wrapper = this.shadowRoot.querySelector('.croppie .embed');
    if (wrapper.firstChild) {
      wrapper.removeChild(wrapper.firstChild);
    }
  }

  private launchCroppie(url: string) {
    const wrapper = this.shadowRoot.querySelector('.croppie .embed');
    if (wrapper.firstChild) {
      wrapper.removeChild(wrapper.firstChild);
    }
    this.showCroppie = true;
    const ele = document.createElement('div');
    wrapper.appendChild(ele);

    const Croppie = (window as any).Croppie;
    this.croppie = new Croppie(ele, {
      enableExif: true,
      viewport: {
        width: 300,
        height: 300,
        type: this.shape
      },
      boundary: {
        width: 400,
        height: 400
      }
    });

    this.croppie.bind({ url });
  }

  private saveResult() {
    const picker = this;
    this.croppie
      .result({
        type: 'blob',
        size: 'viewport',
        format: 'webp',
        quality: 1,
        circle: false
      })
      .then(function (resp: any) {
        const blob = resp;
        picker.url = URL.createObjectURL(blob);

        // const blob = dataURItoBlob(resp);
        const fd = new FormData();
        fd.append(picker.name, blob, 'filename.webp');

        picker.value = fd;
        picker.closeCroppie();
      });
  }

  private handleClearClicked(evt: Event) {
    evt.stopPropagation();
    const fd = new FormData();
    fd.append(`${this.name}-clear`, 'on');
    this.url = null;
    this.value = fd;
  }

  private handleToggleClicked() {
    const fileInput = this.shadowRoot.querySelector('#file');
    (fileInput as any).click();
  }

  private handleFileChanged(e: Event) {
    const input = e.target as any;
    if (input.files.length > 0) {
      this.uploadReader.readAsDataURL(input.files[0]);
    }
    input.value = '';
  }

  protected renderWidget() {
    return html`
      <div class="wrapper ${this.shape} ${this.label ? 'label' : ''}">
        <input class='hidden' type="file" accept="image/*" capture="camera" id="file" name="file" @change=${
          this.handleFileChanged
        }/>
        <div class='toggle-wrapper'>
          <div class='toggle ${this.url ? 'set' : ''}  ${
            this.showCroppie ? 'hidden' : ''
          }' @click=${this.handleToggleClicked} style="background: ${
            this.url
              ? `url('${this.url}') center / contain no-repeat`
              : 'rgba(0, 0, 0, 0.1)'
          }">
            <temba-icon name=${Icon.upload_image} size="1.5"></temba-icon>
          </div>
          ${
            this.clearable && this.url && !this.showCroppie
              ? html`<temba-icon
                  class="clear"
                  name=${Icon.close}
                  size="0.9"
                  @click=${this.handleClearClicked}
                ></temba-icon>`
              : null
          }
        </div>
        
        <temba-mask ?show=${this.showCroppie} class="${
          this.showCroppie ? 'editing' : ''
        }">
          <div class='croppie'>
            <div class='embed'></div>
            <div class='controls'>
              <temba-icon class="close" size="1" name=${Icon.close} @click=${
                this.closeCroppie
              }></temba-icon>
              <div style="flex-grow:1"></div>
              <temba-icon class="submit" size="1" name=${Icon.submit} @click=${
                this.saveResult
              }></temba-icon>
            </div>
        </temba-mask>
      </div>
    `;
  }
}
