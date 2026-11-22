export const extensionMessages = {
  en: {
    notConnected: 'Extension is not connected. DSH automatically uses its own browser (CDP) for new sessions. Optionally choose “Install extension”.',
    connected: 'Connected',
    loadHint: 'Click “Load unpacked” and select the opened folder',
    storeHint: 'Install the extension from the store',
  },
  zh: {
    notConnected: '扩展未连接。DSH 会自动为新会话使用自己的浏览器（CDP）；如需使用个人浏览器，可选点「一键安装扩展」。',
    connected: '已连接',
    loadHint: '点「加载解压缩的扩展」并选择已打开的文件夹',
    storeHint: '请在商店中安装扩展',
  },
}

export const hostMessages = {
  zh: { referenceLabel: '引用到 DSH', referenceFailed: '引用未能加入当前会话，请重试。', dismiss: '关闭' },
  bilingual: {
    unavailableTitle: '页面加载失败 / Page unavailable',
    unavailableDetail: '无法获取上游网页，请检查网络后重试。 / The upstream page could not be loaded. Check your connection and try again.',
    retry: '重试 / Retry',
  },
}

const SESSION_NOT_READY = '当前会话还没准备好，请稍后重新添加这条引用。'
const UNSUPPORTED_FORMAT = '这段内容格式不受支持，请换一段内容再添加。'
const IMAGE_UNREADABLE = '图片没能读取，请右键图片单独添加或重新选择。'
export const referenceCaptureErrors = {
  captureFailed: '网页内容读取失败，请重新选择后再试。',
  storeRefused: '引用保存失败，请稍后重试。',
  imageFailed: '图片引用失败，请右键图片单独添加或重新选择。',
  imageUnreadable: IMAGE_UNREADABLE,
}
export const referenceCaptureMessages = {
  'nothing-captured': '没能读取选中内容，请重新选中后再添加。',
  'empty-text': '选中的是空白内容，请重新选择。',
  'page-changed': '网页刚刚跳转了，请在新页面重新选择。',
  'page-url-missing': '没能获取网页地址，这条引用没有加入。',
  'too-many-parts': '选中的内容片段太多，请分几次添加。',
  'text-too-long': '选中的文字太长，请减少一些再添加。',
  'table-too-large': '这个表格太大，请缩小选择范围。',
  'frame-capture-invalid': '这个内嵌页面无法读取，请在主页面中选择。',
  'frame-capture-refused': '内嵌页面不允许引用，请在主页面中选择。',
  // Session identity could not be established. The old wording blamed the
  // sidebar page; the actionable fix is to wait for the conversation and
  // retry. The key stays, so an existing reason still resolves to a copy.
  'session-unavailable': SESSION_NOT_READY,
  'session-id-required': SESSION_NOT_READY,
  'browser-session-id-required': SESSION_NOT_READY,
  'no-selection': '请先选中网页内容，再点添加引用。',
  'nothing-selected': '请先选中网页内容，再点添加引用。',
  'excerpt-not-found': '没能定位选中的文字，请重新选择。',
  'image-unavailable': '这张图片没能读取，请右键图片单独引用或重新选择。',
  'image-timeout': '图片加载超时，请重试或改选其它内容。',
  'image-too-large': '图片太大，无法加入引用。',
  'image-version-changed': '网页图片已更新，请重新选择后再添加。',
  'image-not-an-image': '选中的不是可引用的图片，请重新选择。',
  'image-has-no-source': IMAGE_UNREADABLE,
  'unsupported-part': UNSUPPORTED_FORMAT,
  'table-missing': UNSUPPORTED_FORMAT,
  'table-empty': UNSUPPORTED_FORMAT,
  'invalid-frame-selector': UNSUPPORTED_FORMAT,
  'capture-refused': '这条引用没有加入，请重新选择后再试。',
}
