'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, PencilLine } from 'lucide-react';
import { eventsApi, type EventItem } from '@/lib/api';
import { EventForm } from '@/components/EventForm';
import { useToast } from '@/components/Toast';

export default function EditEventPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { toast } = useToast();
  const [event, setEvent] = useState<EventItem | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    eventsApi
      .get(params.id)
      .then(({ event: loaded }) => {
        if (alive) setEvent(loaded);
      })
      .catch(() => {
        toast('error', 'Deadline not found');
        router.replace('/dashboard');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  async function saveEvent(input: Parameters<React.ComponentProps<typeof EventForm>['onSubmit']>[0]) {
    try {
      await eventsApi.update(params.id, input);
      toast('success', 'Deadline updated — reminders re-planned');
      router.push('/dashboard');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not save changes');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <PencilLine className="h-5 w-5 text-accent" /> Edit deadline
          </h1>
          <p className="text-sm text-ink-soft">Changes reschedule pending reminders automatically.</p>
        </div>
        <Link href="/dashboard" className="btn-ghost shrink-0">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
      </div>

      {loading ? (
        <div className="neu-card h-96 animate-pulse" />
      ) : (
        event && <EventForm initial={event} submitLabel="Save changes" onSubmit={saveEvent} />
      )}
    </div>
  );
}
