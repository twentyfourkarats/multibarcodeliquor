import {h, render} from 'preact';
import '@shopify/ui-extensions/preact';

export default async () => {
  render(h(Extension, null), document.body);
};

function Extension() {
  return h('s-tile', {
    heading: '24K Barcode Scanner',
    subheading: 'Scan alternate UPC',
    onClick: () => shopify.action.presentModal(),
  });
}
