/** @jsx h */
import {h, render} from 'preact';
import '@shopify/ui-extensions/preact';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-tile
      heading="24K Barcode Scanner"
      subheading="Scan alternate UPC"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
