/** Product copy for the browser-reference dock. */
export const REFERENCE_LOCALE = 'browserReference'
export const zh = {
  count: '{count} 条引用', selected: '所选内容', reveal: '回到原文',
  edit: '编辑评论', remove: '移除此条引用', removeDraft: '从输入框移除这条引用',
  comment: '用户评论', optional: '添加评论（可选）', cancel: '取消', save: '保存',
  image: '引用的图片', table: '引用的表格', loadingImage: '图片正在读取', partial: '部分内容未能完整读取',
} as const
export type ReferenceLabelKey = keyof typeof zh
export type ReferenceLabels = Readonly<Record<ReferenceLabelKey, string>>
export const en: ReferenceLabels = {
  count: '{count} web references', selected: 'Selected content',
  reveal: 'Go to source', edit: 'Edit comment', remove: 'Remove reference',
  comment: 'Your comment', optional: 'Add a comment (optional)', cancel: 'Cancel', save: 'Save',
  image: 'Referenced image', table: 'Referenced table', loadingImage: 'Loading image', partial: 'Some content could not be read completely',
}
export const referenceCopy: Readonly<Record<string, ReferenceLabels>> = {
  zh, en,
  ja: { count: '{count} 件の引用', selected: '選択した内容', reveal: '原文へ戻る', edit: 'コメントを編集', remove: '引用を削除', comment: 'コメント', optional: 'コメントを追加（任意）', cancel: 'キャンセル', save: '保存', image: '引用画像', table: '引用表', loadingImage: '画像を読み込み中', partial: '一部の内容を読み取れませんでした' },
  de: { count: '{count} Webzitate', selected: 'Ausgewählter Inhalt', reveal: 'Zur Quelle', edit: 'Kommentar bearbeiten', remove: 'Zitat entfernen', comment: 'Dein Kommentar', optional: 'Kommentar hinzufügen (optional)', cancel: 'Abbrechen', save: 'Speichern', image: 'Zitiertes Bild', table: 'Zitierte Tabelle', loadingImage: 'Bild wird geladen', partial: 'Einige Inhalte konnten nicht vollständig gelesen werden' },
  fr: { count: '{count} références web', selected: 'Contenu sélectionné', reveal: 'Aller à la source', edit: 'Modifier le commentaire', remove: 'Retirer la référence', comment: 'Votre commentaire', optional: 'Ajouter un commentaire (facultatif)', cancel: 'Annuler', save: 'Enregistrer', image: 'Image citée', table: 'Tableau cité', loadingImage: 'Chargement de l’image', partial: 'Une partie du contenu n’a pas pu être lue' },
  es: { count: '{count} referencias web', selected: 'Contenido seleccionado', reveal: 'Ir a la fuente', edit: 'Editar comentario', remove: 'Quitar referencia', comment: 'Tu comentario', optional: 'Añadir comentario (opcional)', cancel: 'Cancelar', save: 'Guardar', image: 'Imagen citada', table: 'Tabla citada', loadingImage: 'Cargando imagen', partial: 'No se pudo leer todo el contenido' },
  pt: { count: '{count} referências web', selected: 'Conteúdo selecionado', reveal: 'Ir à fonte', edit: 'Editar comentário', remove: 'Remover referência', comment: 'Seu comentário', optional: 'Adicionar comentário (opcional)', cancel: 'Cancelar', save: 'Salvar', image: 'Imagem citada', table: 'Tabela citada', loadingImage: 'Carregando imagem', partial: 'Parte do conteúdo não pôde ser lida' },
  ru: { count: '{count} веб-цитат', selected: 'Выбранное содержимое', reveal: 'К источнику', edit: 'Изменить комментарий', remove: 'Удалить цитату', comment: 'Ваш комментарий', optional: 'Добавить комментарий (необязательно)', cancel: 'Отмена', save: 'Сохранить', image: 'Цитируемое изображение', table: 'Цитируемая таблица', loadingImage: 'Загрузка изображения', partial: 'Часть содержимого не удалось прочитать' },
}
export function referenceLabels(t?: (key: ReferenceLabelKey, args?: { count: number }) => string, count = 0): ReferenceLabels {
  if (t === undefined) return zh
  return Object.fromEntries(Object.keys(zh).map(key => [key, t(key as ReferenceLabelKey, { count })])) as ReferenceLabels
}
