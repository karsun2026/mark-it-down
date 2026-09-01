"use client";

/** Filename, human type label and size, per the §2 mockup. */

import { formatBytes, sourceTypeFor } from "@/lib/filename";
import { HUMAN_TYPE_LABEL } from "@/lib/types";

interface FileSummaryProps {
  file: File;
}

export function FileSummary({ file }: FileSummaryProps) {
  const sourceType = sourceTypeFor(file.name);

  return (
    <div>
      <div className="file-name">{file.name}</div>
      <div className="muted">
        {sourceType ? HUMAN_TYPE_LABEL[sourceType] : "Unsupported file"}
        {" · "}
        {formatBytes(file.size)}
      </div>
    </div>
  );
}
