type Props = { arxivId: string };
export function PaperReader({ arxivId }: Props) {
  return <div className="p-4 text-slate-300">Reader for {arxivId}</div>;
}
