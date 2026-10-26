import { createContext, useContext } from 'react'
import type { Services } from '@/application/ports'

export const ServicesContext = createContext<Services | null>(null)

export function useServices(): Services {
  const services = useContext(ServicesContext)
  if (services === null) throw new Error('The composition root must provide services')
  return services
}
