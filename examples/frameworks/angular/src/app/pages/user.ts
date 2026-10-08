import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

@Component({
  template: `<h1>User {{ id }}</h1>`,
})
export class UserPage {
  protected readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id');
}
