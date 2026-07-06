import LogViewer from './LogViewer';

export default function Page({ params }: { params: { name: string } }) {
  return <LogViewer name={decodeURIComponent(params.name)} />;
}
