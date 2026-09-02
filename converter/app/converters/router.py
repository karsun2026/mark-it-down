"""Select a converter from the validated source type (ENGINEERING_SPEC.md §32).

Routing keys off the type established by real content inspection in
`app.security.validation`, never off the uploaded filename.
"""

from __future__ import annotations

from app.converters.base import BaseConverter
from app.converters.docx import DocxConverter
from app.converters.pdf import PdfConverter
from app.converters.pptx import PptxConverter
from app.security.validation import SourceType
from app.services.workspace import JobWorkspace

_CONVERTERS: dict[SourceType, type[BaseConverter]] = {
    SourceType.DOCX: DocxConverter,
    SourceType.PPTX: PptxConverter,
    SourceType.PDF: PdfConverter,
}


def converter_for(
    source_type: SourceType,
    workspace: JobWorkspace,
    output_stem: str,
    include_media: bool = True,
) -> BaseConverter:
    """Build the converter for `source_type`."""
    converter_class = _CONVERTERS[source_type]
    return converter_class(workspace, output_stem, include_media)
