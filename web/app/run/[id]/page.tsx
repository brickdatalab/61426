import RunViewer from './RunViewer';

export default function Page({ params }: { params: { id: string } }) {
  return <RunViewer runId={params.id} />;
}
