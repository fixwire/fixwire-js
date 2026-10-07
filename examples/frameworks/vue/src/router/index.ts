import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/users/:id', name: 'user', component: () => import('../views/UserView.vue') },
    {
      path: '/reports',
      name: 'reports',
      component: () => import('../views/UserView.vue'),
      // A guard that fails: the router reports it, and the navigation stops.
      beforeEnter: () => {
        throw new Error('Reports are unavailable: the reporting service timed out')
      },
    },
  ],
})

export default router
