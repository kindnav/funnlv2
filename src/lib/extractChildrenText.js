// Extracts visible text from React children without importing React.
// React elements are plain JavaScript objects — this function traverses that
// structure without needing a DOM or browser environment, making it safely
// testable in plain Node.js.
// Exported separately from the component that uses it so it can be unit-tested.

/**
 * Recursively extract a plain-text string from a React children value.
 *
 * Handles: strings, numbers, arrays, and React elements (objects with `.props.children`).
 * Returns an empty string for null, undefined, booleans, and unrecognised types.
 *
 * @param {any} children - React children prop value
 * @returns {string} plain text extracted from the children tree
 */
export function extractChildrenText(children) {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (!children && children !== 0) return ''
  if (Array.isArray(children)) {
    return children.map(extractChildrenText).join('')
  }
  // React element: a plain object with a `props` property containing nested children
  if (typeof children === 'object' && Object.prototype.hasOwnProperty.call(children, 'props')) {
    return extractChildrenText(children.props?.children)
  }
  return ''
}
