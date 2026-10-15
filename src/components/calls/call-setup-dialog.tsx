'use client'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Phone } from 'lucide-react'
import { useT } from '@/lib/i18n'

interface CallSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CallSetupDialog({ open, onOpenChange }: CallSetupDialogProps) {
  const t = useT()
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-10 w-10 rounded-xl flex items-center justify-center" style={{ background: '#EDE5FF' }}>
              <Phone className="h-5 w-5" style={{ color: '#7C5CFC' }} />
            </div>
            <AlertDialogTitle>{t('Calls not enabled')}</AlertDialogTitle>
          </div>
          <AlertDialogDescription className="text-left">
            {t('Video and audio calls require LiveKit to be configured. An admin needs to add LiveKit credentials in')}{' '}
            <strong>{t('Workspace Settings → Calls')}</strong>{' '}
            {t('to enable this feature.')}
            <br /><br />
            {t('You can get free LiveKit credentials at')}{' '}
            <a href="https://cloud.livekit.io" target="_blank" rel="noopener noreferrer" className="text-[#7C5CFC] hover:underline">
              cloud.livekit.io
            </a>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction style={{ background: '#7C5CFC' }}>{t('Got it')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
