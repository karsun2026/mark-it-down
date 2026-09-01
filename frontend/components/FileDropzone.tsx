"use client";

/**
 * Drag/drop zone with a keyboard-accessible alternative (§54).
 *
 * The zone is a real <button>, so it is focusable and activates on Enter and
 * Space without any extra key handling. Drag and drop is an enhancement on
 * top, never the only route to selecting a file.
 */

import { useRef, useState } from "react";

import { MAX_UPLOAD_BYTES, SUPPORTED_EXTENSIONS } from "@/lib/types";

interface FileDropzoneProps {
  onSelect: (file: File) => void;
  disabled?: boolean;
}

export function FileDropzone({ onSelect, disabled }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file) onSelect(file);
  }

  return (
    <>
      <button
        type="button"
        className="dropzone"
        data-dragging={dragging}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
      >
        <span className="dropzone-title">Drop a file here</span>
        <br />
        <span className="muted">or choose a file from your computer</span>
        <br />
        <br />
        <span className="muted">
          DOCX · PPTX · PDF — maximum {MAX_UPLOAD_BYTES / (1024 * 1024)} MB
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        className="visually-hidden"
        accept={SUPPORTED_EXTENSIONS.join(",")}
        onChange={(event) => {
          handleFiles(event.target.files);
          // Reset so selecting the same file twice still fires onChange.
          event.target.value = "";
        }}
        // The button above is the labelled control; this input is the
        // mechanism, hidden from the tab order to avoid a duplicate stop.
        tabIndex={-1}
        aria-hidden="true"
      />
    </>
  );
}
