import { useState } from 'react';
import { Eye, Pencil } from 'lucide-react';
import { Markdown } from './Markdown';
import { Modal } from './Modal';

/**
 * Modal de edição em tela cheia para campos markdown (instruções de agente,
 * conteúdo de skill, documentos de conhecimento), com alternância entre o
 * editor cru e a visualização renderizada.
 */
export function MarkdownEditorModal(props: {
  title: string;
  value: string;
  placeholder?: string;
  /** Sem onChange o modal é somente leitura (abre direto na visualização). */
  onChange?: (value: string) => void;
  onClose: () => void;
}) {
  const readOnly = !props.onChange;
  const [preview, setPreview] = useState(readOnly);

  return (
    <Modal
      title={props.title}
      wide
      onClose={props.onClose}
      footer={
        <button className="btn btn--primary" onClick={props.onClose}>
          Concluir
        </button>
      }
    >
      <div className="md-modal__bar">
        {!readOnly && (
          <button
            className={`btn btn--sm${preview ? '' : ' btn--primary'}`}
            onClick={() => setPreview(false)}
          >
            <Pencil className="icon" aria-hidden /> Editar
          </button>
        )}
        <button
          className={`btn btn--sm${preview ? ' btn--primary' : ''}`}
          onClick={() => setPreview(true)}
        >
          <Eye className="icon" aria-hidden /> Visualizar
        </button>
      </div>
      {preview ? (
        <div className="md-modal__preview">
          {props.value.trim() ? (
            <Markdown text={props.value} />
          ) : (
            <p className="page-hint">Nada para visualizar ainda — o conteúdo está vazio.</p>
          )}
        </div>
      ) : (
        <textarea
          className="modal-editor"
          value={props.value}
          onChange={(e) => props.onChange?.(e.target.value)}
          placeholder={props.placeholder}
          autoFocus
        />
      )}
    </Modal>
  );
}
