package com.gesturecontrol

import android.content.Context
import android.graphics.drawable.Drawable
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView

class AppAdapter(private val apps: List<AppItem>, private val context: Context) : RecyclerView.Adapter<AppAdapter.VH>() {

    data class AppItem(val label: String, val pkg: String, val icon: Drawable)

    private val selected = mutableSetOf<String>()

    fun setSelectedPackages(pkgs: Set<String>) {
        selected.clear()
        selected.addAll(pkgs)
        notifyDataSetChanged()
    }

    fun getSelectedPackages(): Set<String> = selected

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_app, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val a = apps[position]
        holder.label.text = a.label
        holder.icon.setImageDrawable(a.icon)
        holder.itemView.isSelected = selected.contains(a.pkg)
        holder.itemView.setOnClickListener {
            if (selected.contains(a.pkg)) selected.remove(a.pkg) else selected.add(a.pkg)
            notifyItemChanged(position)
        }
    }

    override fun getItemCount(): Int = apps.size

    class VH(view: View) : RecyclerView.ViewHolder(view) {
        val icon: ImageView = view.findViewById(R.id.app_icon)
        val label: TextView = view.findViewById(R.id.app_label)
    }
}
