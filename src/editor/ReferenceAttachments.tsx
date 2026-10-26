import { Ico } from "./uiIcons";

/** チャットの添付資料は、画像の寸法に左右されないファイル表示にする。 */
export function ReferenceAttachments({ files, disabled, onRemove }: {
  files: { name: string }[];
  disabled?: boolean;
  onRemove: (index: number) => void;
}) {
  if (!files.length) return null;
  return (
    <ul className="reference-files" aria-label="添付した参考資料">
      {files.map((file, i) => (
        <li key={i} className="reference-file" title={file.name}>
          <Ico name="file" size={18} />
          <span className="reference-file-name">{file.name}</span>
          <button type="button" className="icon-btn" aria-label={`${file.name} を外す`} title="外す" disabled={disabled} onClick={() => onRemove(i)}>
            <Ico name="x" size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}
