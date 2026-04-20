import { useParams } from "react-router-dom";
import { PaperReader } from "@/components/PaperReader";

export function ReaderRoute() {
  const { arxivId } = useParams<{ arxivId: string }>();
  if (!arxivId) return null;
  return <PaperReader arxivId={arxivId} />;
}
